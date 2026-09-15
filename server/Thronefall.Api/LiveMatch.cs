using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Thronefall.Engine;

namespace Thronefall.Api;

/// <summary>
/// The real-time player protocol (docs/GAME_DESIGN.md §5.3).
///
/// The client sends intents and renders what comes back; it decides nothing.
/// Every command is validated by the engine against server-held state, so a
/// tampered client can at most get its command rejected.
///
/// All socket writes happen on the tick loop. The receive loop only buffers
/// into the PlayerController's queue — that keeps a single writer on the
/// socket (concurrent WebSocket sends are illegal) and means input can never
/// land mid-tick and split a tick's resolution.
///
/// Wire format — client to server:
///   {"type":"command","kind":"build|train|repair|castRage","arg":"farm","seq":1}
/// Server to client:
///   {"type":"matchStarted",...}  once, with the static cost catalog
///   {"type":"ack",...}           one per command, accepted or rejected
///   {"type":"state",...}         one per tick
///   {"type":"matchEnded",...}    once
/// </summary>
public static class LiveMatch
{
    // Nulls are written explicitly and deliberately. Omitting them made
    // "no build in progress" arrive as `undefined` instead of `null`, and a
    // client checking `buildBusy === null` silently never matched — it just
    // stopped issuing commands rather than failing loudly. The state shape
    // has to be stable for a client that holds no logic of its own.
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsync("expected a WebSocket request");
            return;
        }

        // Opponent is a bot for now: real PvP needs matchmaking, which isn't
        // built yet. MatchSession takes two controllers of any kind, so
        // pairing two PlayerControllers is the only change needed later.
        var opponentKey = context.Request.Query["opponent"].FirstOrDefault() ?? "atk";
        var strategyExists = Strategies.All.TryGetValue(opponentKey, out var opponentStrategy);

        // Wall-clock seconds per tick, compressed for testing. A real client
        // leaves this at 1; the end-to-end test would otherwise take 6 minutes.
        var speed = 1.0;
        if (double.TryParse(context.Request.Query["speed"].FirstOrDefault(), out var parsed))
            speed = Math.Clamp(parsed, 1, 200);

        using var socket = await context.WebSockets.AcceptWebSocketAsync();

        if (!strategyExists)
        {
            await SendAsync(socket, new { type = "error", message = $"unknown opponent '{opponentKey}' — use eco, def or atk" }, CancellationToken.None);
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bad request", CancellationToken.None);
            return;
        }

        var player = new PlayerController("player");
        var session = new MatchSession(player, new BotController(opponentStrategy!), endEarlyOnKeepKill: true);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        var notices = new ConcurrentQueue<object>();
        var receiver = ReceiveLoopAsync(socket, player, notices, cts);

        try
        {
            await SendAsync(socket, new
            {
                type = "matchStarted",
                side = "A",
                opponent = opponentKey,
                duration = MatchSession.Duration,
                speed,
                catalog = SnapshotBuilder.Catalog(),
            }, cts.Token);

            var clock = Stopwatch.StartNew();
            var tickMs = 1000.0 / speed;

            while (!cts.IsCancellationRequested && session.Step())
            {
                while (notices.TryDequeue(out var notice)) await SendAsync(socket, notice, cts.Token);
                foreach (var ack in player.DrainAcks()) await SendAsync(socket, Envelope("ack", ack), cts.Token);
                await SendAsync(socket, Envelope("state", SnapshotBuilder.Build(session, viewerIsA: true)), cts.Token);

                if (session.Finished) break;

                // absolute deadline per tick, so sending cost doesn't make the
                // match drift slower than the simulated clock
                var wait = (session.Tick + 1) * tickMs - clock.Elapsed.TotalMilliseconds;
                if (wait > 0) await Task.Delay(TimeSpan.FromMilliseconds(wait), cts.Token);
            }

            if (session.Finished && session.Result is { } result)
            {
                await SendAsync(socket, new
                {
                    type = "matchEnded",
                    winner = SnapshotBuilder.Build(session, viewerIsA: true).Winner,
                    absoluteWinner = result.Winner,
                    tiebreak = result.Tiebreak,
                    endedAtTick = session.Tick,
                }, cts.Token);
            }
        }
        catch (OperationCanceledException)
        {
            // client went away mid-match — nothing to report
        }
        finally
        {
            cts.Cancel();
            try { await receiver; } catch { /* receive loop teardown */ }
            if (socket.State == WebSocketState.Open)
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "match over", CancellationToken.None);
        }
    }

    private static async Task ReceiveLoopAsync(
        WebSocket socket, PlayerController player, ConcurrentQueue<object> notices, CancellationTokenSource cts)
    {
        var buffer = new byte[4 * 1024];
        var message = new MemoryStream();
        try
        {
            while (!cts.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var received = await socket.ReceiveAsync(buffer, cts.Token);
                if (received.MessageType == WebSocketMessageType.Close)
                {
                    cts.Cancel();
                    return;
                }
                message.Write(buffer, 0, received.Count);
                if (!received.EndOfMessage) continue;

                var text = Encoding.UTF8.GetString(message.ToArray());
                message.SetLength(0);

                if (TryParseCommand(text, out var command, out var reason)) player.Submit(command!);
                else notices.Enqueue(new { type = "error", message = reason });
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { cts.Cancel(); }
    }

    private static bool TryParseCommand(string text, out PlayerCommand? command, out string reason)
    {
        command = null;
        reason = "";
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (!root.TryGetProperty("kind", out var kindProp) || kindProp.ValueKind != JsonValueKind.String)
            {
                reason = "command needs a string 'kind'";
                return false;
            }
            if (!Enum.TryParse<CommandKind>(kindProp.GetString(), ignoreCase: true, out var kind))
            {
                reason = $"unknown kind '{kindProp.GetString()}' — use build, train, repair or castRage";
                return false;
            }
            var arg = root.TryGetProperty("arg", out var argProp) && argProp.ValueKind == JsonValueKind.String
                ? argProp.GetString()!
                : "";
            long? seq = root.TryGetProperty("seq", out var seqProp) && seqProp.TryGetInt64(out var s) ? s : null;
            command = new PlayerCommand(kind, arg, seq);
            return true;
        }
        catch (JsonException)
        {
            reason = "malformed JSON";
            return false;
        }
    }

    private static object Envelope(string type, object payload) => new TypedEnvelope(type, payload);

    private sealed record TypedEnvelope(string Type, object Payload);

    private static async Task SendAsync(WebSocket socket, object payload, CancellationToken token)
    {
        if (socket.State != WebSocketState.Open) return;
        // flatten {type, payload} so the client sees one object, not a wrapper
        string text;
        if (payload is TypedEnvelope envelope)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteString("type", envelope.Type);
                foreach (var prop in JsonSerializer.SerializeToElement(envelope.Payload, Json).EnumerateObject())
                    prop.WriteTo(writer);
                writer.WriteEndObject();
            }
            text = Encoding.UTF8.GetString(stream.ToArray());
        }
        else
        {
            text = JsonSerializer.Serialize(payload, Json);
        }
        await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, endOfMessage: true, token);
    }
}
