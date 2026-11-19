using Bastion.Server.Auth;
using Microsoft.AspNetCore.Mvc;

namespace Bastion.Server.Controllers;

/// <summary>Basis aller API-Controller: Zugriff auf den angemeldeten Benutzer und die Herkunft der Anfrage.</summary>
[ApiController]
[Produces("application/json")]
public abstract class BastionController : ControllerBase
{
    protected AuthContext Auth => HttpContext.Auth();
    protected RequestMeta Meta => HttpContext.Meta();

    protected static object OkResult => new { ok = true };
}
