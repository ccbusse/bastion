namespace Bastion.Server.Emergency;

public static class EmergencyRegistration
{
    /// <summary>Notfall-Backup: Backup-Datei, automatischer Export (Hintergrunddienst, Takt 1 Minute).</summary>
    public static IServiceCollection AddEmergencyServices(this IServiceCollection services)
    {
        services.AddScoped<EmergencyBackupService>();
        services.AddSingleton<EmergencyAutoService>();
        services.AddHostedService(sp => sp.GetRequiredService<EmergencyAutoService>());
        return services;
    }
}
