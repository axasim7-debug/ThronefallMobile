using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Thronefall.Engine;

// Minimal authoritative-server proof of connectivity (docs/GAME_DESIGN.md
// §5.3): a real WebSocket endpoint backed by the SAME MatchEngine that's
// cross-validated against tools/balance-sim's JS numbers
// (Thronefall.Engine.Tests). This first pass runs a bot-vs-bot match and
// streams the result — it does NOT yet accept live player commands; that's
// the next real step (docs/PROGRESS.md), not something to fake here.

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok", engine = "Thronefall.Engine" }));

app.UseWebSockets();

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

    var (a, b, result) = MatchEngine.Simulate(stratA, stratB);

    await SendJson(socket, new
    {
        type = "matchResult",
        winner = result.Winner,
        tiebreak = result.Tiebreak,
        a = Summarize(a),
        b = Summarize(b),
    });

    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "match complete", CancellationToken.None);
});

app.Run();

static object Summarize(PlayerState pl) => new
{
    strategy = pl.Strategy,
    troopsProduced = pl.TroopsProduced,
    armyValue = pl.ArmyValue,
    keepDestroyedAt = pl.KeepDestroyedAtT,
    keepHpRemaining = Math.Round(MatchEngine.CurrentHp(pl.Keep, Content.Economy.DurationSeconds)),
};

static async Task SendJson(WebSocket socket, object payload)
{
    var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
    await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None);
}
