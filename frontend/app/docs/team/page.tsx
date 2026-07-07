import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Badge } from "@/components/ui/badge";

export default function TeamDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Configuration"
        title="Team & invites"
        description="Members, roles, and pending invites for this workspace — a deliberately simple, mock-only page."
      />

      <Callout tone="warning" title="Frontend-only, no backend, no Clerk" className="mb-8">
        The Team page (<code className="font-mono">app/team/page.tsx</code>) has no backend counterpart at
        all — no roles/permissions table, no invite-token flow, no auth-provider integration. It renders
        deterministic mock members and invites from <code className="font-mono">lib/mock-data.ts</code>, and
        &quot;Invite&quot;/&quot;Remove&quot;/&quot;Revoke&quot; only mutate local Zustand state for the current session.
      </Callout>

      <section className="mb-10">
        <h2 id="shape" className="mb-3 text-lg font-semibold text-foreground">Shape</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Three roles, no granular permission matrix — kept deliberately simple to match this dashboard&apos;s
          existing scope:
        </p>
        <CodeBlock label="lib/types.ts">{`const TEAM_ROLES = ["admin", "member", "support"] as const;

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member" | "support";
  joinedAt: string;
}

interface TeamInvite {
  id: string;
  email: string;
  role: "admin" | "member" | "support";
  invitedAt: string;
  invitedBy: string;
  status: "pending" | "expired";
}`}</CodeBlock>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="neutral" className="font-mono normal-case">admin</Badge>
          <Badge tone="neutral" className="font-mono normal-case">member</Badge>
          <Badge tone="neutral" className="font-mono normal-case">support</Badge>
        </div>
      </section>

      <section>
        <h2 id="what-roles-gate" className="mb-3 text-lg font-semibold text-foreground">What the roles actually gate</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Nothing, today. <code className="font-mono">role</code> is stored and displayed but does not
          currently change what any team member can see or do anywhere else in this dashboard — every page
          renders the same for every role. Treat this as a UI/data-shape placeholder for a future
          permissions system, not a working access-control feature.
        </p>
      </section>
    </div>
  );
}
