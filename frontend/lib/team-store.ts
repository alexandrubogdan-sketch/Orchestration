import { create } from "zustand";
import type { TeamInvite, TeamMember, TeamRole } from "./types";
import { getMockTeamInvites, getMockTeamMembers } from "./mock-data";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

interface TeamStoreState {
  members: TeamMember[];
  invites: TeamInvite[];
  /** Mock-only: no email is actually sent — just appends a pending invite
   *  locally, same convention as connect()/addIntegration() in
   *  lib/integration-store.ts. Returns the new invite id. */
  inviteMember: (email: string, role: TeamRole) => string;
  updateMemberRole: (id: string, role: TeamRole) => void;
  removeMember: (id: string) => void;
  revokeInvite: (id: string) => void;
  /** Resets invitedAt to now and status back to "pending" — mock stand-in
   *  for re-sending the invite email. */
  resendInvite: (id: string) => void;
  reset: () => void;
}

export const useTeamStore = create<TeamStoreState>((set) => ({
  members: getMockTeamMembers(),
  invites: getMockTeamInvites(),

  inviteMember: (email, role) => {
    const id = randomId("invite");
    set((state) => ({
      invites: [
        ...state.invites,
        {
          id,
          email,
          role,
          invitedAt: new Date().toISOString(),
          invitedBy: state.members.find((m) => m.role === "admin")?.name ?? "You",
          status: "pending",
        },
      ],
    }));
    return id;
  },

  updateMemberRole: (id, role) =>
    set((state) => ({
      members: state.members.map((m) => (m.id === id ? { ...m, role } : m)),
    })),

  removeMember: (id) =>
    set((state) => ({ members: state.members.filter((m) => m.id !== id) })),

  revokeInvite: (id) =>
    set((state) => ({ invites: state.invites.filter((i) => i.id !== id) })),

  resendInvite: (id) =>
    set((state) => ({
      invites: state.invites.map((i) =>
        i.id === id ? { ...i, invitedAt: new Date().toISOString(), status: "pending" } : i,
      ),
    })),

  reset: () => set({ members: getMockTeamMembers(), invites: getMockTeamInvites() }),
}));
