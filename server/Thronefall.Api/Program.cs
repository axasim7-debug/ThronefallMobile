using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Thronefall.Api;
using Thronefall.PositionalEngine;

// Authoritative game server (docs/GAME_DESIGN.md §5.3), backed by
// Thronefall.PositionalEngine — the continuous positional combat model,
// cross-validated against tools/battle-sim's JS numbers
// (Thronefall.PositionalEngine.Tests). Replaces the old staged/instant
// engine here; see docs/PROGRESS.md for the full pivot history.
//
//   /ws/match       real-time match driven by real player commands
//   /ws/demo-match  bot-vs-bot, result only — kept as the connectivity smoke test

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok", engine = "Thronefall.PositionalEngine" }));

app.UseWebSockets();

// Real-time player protocol — see LiveMatch.cs for the wire format.
app.Map("/ws/match", LiveMatch.HandleAsync);

app.Map("/ws/demo-match", async (HttpContext context) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();

    var stratAKey = context.Request.Query["a"].FirstOrDefault() ?? "eco";
    var stratBKey = context.Request.Query["b"].FirstOrDefault() ?? "atk";
    if (!Strategies.All.TryGetValue(stratAKey, out var stratA) || !Strategies.All.TryGetValue(stratBKey, out var stratB))
    {
        await SendJson(socket, new { type = "error", message = "unknown strategy — use a/b query params: eco, def, atk" });
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bad request", CancellationToken.None);
        return;
    }

    await SendJson(socket, new { type = "matchStarted", a = stratAKey, b = stratBKey });

    var (battle, a, b, result) = Match.SimulateMatch(stratA, stratB);

    await SendJson(socket, new
    {
        type = "matchResult",
        winner = result.Winner,
        tiebreak = result.Tiebreak,
        a = Summarize(battle, a),
        b = Summarize(battle, b),
    });

    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "match complete", CancellationToken.None);
});

app.Run();

static object Summarize(Battle battle, MatchPlayer pl) => new
{
    strategy = pl.Name,
    troopsProduced = pl.TroopsProduced,
    keepDestroyedAt = Match.KeepDestroyedAtT(battle, pl),
    keepHpRemaining = Math.Round(battle.Structures[pl.KeepId].Hp),
};

static async Task SendJson(WebSocket socket, object payload)
{
    var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
    await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None);
}
