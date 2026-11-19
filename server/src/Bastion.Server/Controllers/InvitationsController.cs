using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bastion.Server.Controllers;

/// <summary>Das Einladungstoken wird im Body übertragen, nie in der URL: So gelangt es nicht in Zugriffsprotokolle.</summary>
[Route("api/invitations")]
public sealed class InvitationsController(InvitationService invitations) : BastionController
{
    [Public, Throttle(20), Ok200, HttpPost("describe")]
    public Task<object> Describe(InvitationTokenDto body) => invitations.Describe(body.Token);

    [Public, Throttle(10), Ok200, HttpPost("accept")]
    public async Task<object> Accept(AcceptInvitationDto body)
    {
        await invitations.Accept(body, Meta);
        return OkResult;
    }
}
