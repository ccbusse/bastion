namespace Bastion.Server.Services;

public static class ServiceRegistration
{
    /// <summary>Fachliche Dienste (Einladungen, Notfall-Backup, Exportziele).</summary>
    public static IServiceCollection AddBastionDomainServices(this IServiceCollection services)
    {
        services.AddScoped<InvitationService>();
        return services;
    }
}
