/** A real ai-propose response body without the LLM: the backend's own
 *  simulation and signing (`live.matrix.simulate_groups` / `simulate_hints`
 *  / `sign_proposal`, incl. the cross-field switch) run on a fixed parsed
 *  reply via `manage.py shell` in the dev stack's backend container. The spec route-mocks `/ai-propose`
 *  with it, so ai-apply / ai-undo then run for real against the backend.
 *  Test-side only — no test endpoint in the app. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface ParsedGroup {
  cards: number[];
  title: string;
  description?: string;
  reason?: string;
}
export interface ParsedHint {
  cards: number[];
  reason?: string;
}

const SCRIPT = `
import json, sys
from live import matrix
from live.models import Run
from rooms.models import Question
data = json.loads(sys.stdin.read())
run = Run.objects.get(pk=data["run"])
question = Question.objects.get(pk=data["question"])
cross_field = data["cross_field"]
groups = [dict(g, index=i) for i, g in enumerate(data["groups"])]
hints = [] if cross_field else [dict(h, index=i) for i, h in enumerate(data["hints"])]
previews = matrix.simulate_groups(run, question, groups, cross_field)
hint_previews = matrix.simulate_hints(run, question, hints, cross_field)
skipped = sum(1 for g in previews if g["status"] != "ok")
print("@@" + json.dumps({
    "groups": previews,
    "hints": hint_previews,
    "dropped": skipped + len(hints) - len(hint_previews),
    "proposal": matrix.sign_proposal(
        run, question, matrix.with_tops(groups, previews), hints, 0, cross_field
    ),
}))
`;

export function signedProposal(
  runId: number,
  questionId: number,
  groups: ParsedGroup[],
  hints: ParsedHint[] = [],
  /** "Also group across fields" (the propose body's `cross_field`). */
  crossField = false,
): Record<string, unknown> {
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'backend', 'python', 'manage.py', 'shell', '-c', SCRIPT],
    {
      cwd: REPO,
      input: JSON.stringify({
        run: runId,
        question: questionId,
        groups: groups.map((g) => ({ description: '', reason: '', ...g })),
        hints: hints.map((h) => ({ reason: '', ...h })),
        cross_field: crossField,
      }),
      encoding: 'utf8',
    },
  );
  const line = out.split('\n').find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`No proposal from the backend: ${out}`);
  return JSON.parse(line.slice(2));
}

/** Apply AI groups for real (signed via `signedProposal`, then ai-apply as
 *  the presenter): the summary cards exist without any UI or LLM. Returns
 *  the ai-apply body (`applied`, `skipped`, `undo`, `matrix`). */
export async function applySummary(
  api: { post: (url: string, body?: unknown) => Promise<any> },
  runId: number,
  questionId: number,
  groups: ParsedGroup[],
  edits: Record<number, { title?: string; description?: string; category?: string }> = {},
) {
  const body = signedProposal(runId, questionId, groups);
  return api.post(`/api/runs/${runId}/matrix/${questionId}/ai-apply`, {
    proposal: body.proposal,
    selected: groups.map((_, i) => i),
    edits,
  });
}
