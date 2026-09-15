namespace Thronefall.Engine;

public sealed class Structure
{
    public double MaxHp { get; init; }
    public double DamageTaken { get; set; }
    public bool Destroyed { get; set; }
    public Structure(double maxHp) => MaxHp = maxHp;
}

public sealed class FarmInstance
{
    public double Hp { get; set; }
    public bool IncomeRemoved { get; set; }
}

public sealed class Disruption
{
    public double Amount { get; init; }
    public int Until { get; init; }
}

public sealed class CommanderInstance
{
    public required string Key { get; init; }
    public required Dictionary<string, int> Levels { get; init; }
    public double Rage { get; set; }
    public int Casts { get; set; }

    public bool IsMastered() => Levels.Values.All(l => l >= 5);
}

public sealed class MatchStats
{
    public int DiedAtWall;
    public int StoppedAtTower;
    public int ReachedKeep;
    public int TowersLost;
    public int RepairsDone;
    public int FarmsRaided;
}

public sealed class PlayerState
{
    public required string Strategy { get; init; }
    public double Gold { get; set; }
    public double Income { get; set; }
    public List<FarmInstance> Farms { get; } = new();
    public double WallHp { get; set; }
    public double WallMaxHp { get; set; }
    public bool HasBarracks { get; set; }
    public string? BuildBusy { get; set; }
    public double BuildTimer { get; set; }
    public bool TroopBusy { get; set; }
    public double TroopTimer { get; set; }
    public string? TroopKey { get; set; }
    public int TroopsProduced { get; set; }
    public double ArmyValue { get; set; }
    public List<Disruption> Disruptions { get; set; } = new();
    public List<Structure> Towers { get; init; } = new();
    public required Structure Keep { get; init; }
    public int? KeepDestroyedAtT { get; set; }
    public Structure? RepairTargetTower { get; set; }
    public List<CommanderInstance> Commanders { get; init; } = new();
    public MatchStats Stats { get; } = new();
    public int? BarracksT { get; set; }
    public int? FirstTroopT { get; set; }
}

// TroopKey and DepartedAt exist for the client only — combat resolution never
// reads them (it works off Hp/Dps/Bypasses/DamageProfile/DefenseResistFactor,
// already resolved with every commander bonus baked in). They're what let a
// snapshot report "this troop is 40% of the way there" instead of a unit that
// teleports from produced to arrived — see docs/ART_DIRECTION.md's opening
// finding: without this, nothing on the battlefield could ever be shown to
// move, however good the art was.
public sealed record MarchingTroop(
    string TroopKey, int DepartedAt, int ArriveAt, double Hp, double Dps,
    string[]? Bypasses, IReadOnlyDictionary<string, double>? DamageProfile, double DefenseResistFactor);
