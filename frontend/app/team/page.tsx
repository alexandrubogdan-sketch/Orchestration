"use client";

import { useState } from "react";
import { Mail, RotateCcw, Trash2, UserPlus, XCircle } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Select } from "@/components/ui/input";
import { TeamAvatar } from "@/components/team/team-avatar";
import { InviteMemberDialog } from "@/components/team/invite-member-dialog";
import { useTeamStore } from "@/lib/team-store";
import { TEAM_ROLE_LABELS, TEAM_ROLES, type TeamRole } from "@/lib/types";
import { formatDate, relativeTime } from "@/lib/utils";

const ROLE_BADGE_TONE: Record<TeamRole, BadgeTone> = {
  admin: "accent",
  member: "info",
  support: "warning",
};

export default function TeamPage() {
  const members = useTeamStore((s) => s.members);
  const invites = useTeamStore((s) => s.invites);
  const inviteMember = useTeamStore((s) => s.inviteMember);
  const updateMemberRole = useTeamStore((s) => s.updateMemberRole);
  const removeMember = useTeamStore((s) => s.removeMember);
  const revokeInvite = useTeamStore((s) => s.revokeInvite);
  const resendInvite = useTeamStore((s) => s.resendInvite);

  const [inviting, setInviting] = useState(false);

  return (
    <>
      <Topbar title="Team" description="Manage who has access to this dashboard and their role" />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {members.length} member(s) · {invites.length} pending invite(s)
          </span>
          <Button size="sm" onClick={() => setInviting(true)}>
            <UserPlus className="h-3.5 w-3.5" /> Invite member
          </Button>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Members</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Email</TH>
                    <TH>Role</TH>
                    <TH>Joined</TH>
                    <TH></TH>
                  </TR>
                </THead>
                <TBody>
                  {members.map((member) => (
                    <TR key={member.id}>
                      <TD>
                        <div className="flex items-center gap-2.5">
                          <TeamAvatar id={member.id} name={member.name} />
                          <span className="font-medium">{member.name}</span>
                        </div>
                      </TD>
                      <TD className="text-sm text-muted-foreground">{member.email}</TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <Badge tone={ROLE_BADGE_TONE[member.role]}>{TEAM_ROLE_LABELS[member.role]}</Badge>
                          <Select
                            aria-label={`Change role for ${member.name}`}
                            value={member.role}
                            onChange={(e) => updateMemberRole(member.id, e.target.value as TeamRole)}
                            className="h-7 text-xs"
                          >
                            {TEAM_ROLES.map((role) => (
                              <option key={role} value={role}>
                                {TEAM_ROLE_LABELS[role]}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </TD>
                      <TD className="text-sm text-muted-foreground">{formatDate(member.joinedAt)}</TD>
                      <TD>
                        <button
                          onClick={() => removeMember(member.id)}
                          title="Remove member"
                          className="text-muted-foreground transition-colors hover:text-danger"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {members.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No members yet — invite someone to get started.
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pending invites</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {invites.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No pending invites.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {invites.map((invite) => (
                    <li key={invite.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-bg text-muted-foreground">
                        <Mail className="h-4 w-4" />
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium">{invite.email}</div>
                        <div className="text-xs text-muted-foreground">
                          Invited by {invite.invitedBy} · {relativeTime(invite.invitedAt)}
                        </div>
                      </div>
                      <Badge tone={ROLE_BADGE_TONE[invite.role]}>{TEAM_ROLE_LABELS[invite.role]}</Badge>
                      <Badge tone={invite.status === "pending" ? "neutral" : "danger"}>
                        {invite.status === "pending" ? "Pending" : "Expired"}
                      </Badge>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="outline" onClick={() => resendInvite(invite.id)}>
                          <RotateCcw className="h-3.5 w-3.5" /> Resend
                        </Button>
                        <button
                          onClick={() => revokeInvite(invite.id)}
                          title="Revoke invite"
                          className="p-1.5 text-muted-foreground transition-colors hover:text-danger"
                        >
                          <XCircle className="h-4 w-4" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {inviting ? (
        <InviteMemberDialog
          onInvite={(email, role) => inviteMember(email, role)}
          onClose={() => setInviting(false)}
        />
      ) : null}
    </>
  );
}
