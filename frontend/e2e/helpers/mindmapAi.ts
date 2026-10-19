/** A signed mind-map AI proposal without the LLM: the backend signs a fixed,
 *  already parsed list of ops (`live.mindmap.sign_proposal`) via
 *  `manage.py shell` in the dev stack's backend container — the same blob
 *  `ai-optimize` returns after its LLM call. `ai-apply` then runs for real.
 *  Test-side only — no test endpoint in the app. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export type MindmapAiOp = Record<string, unknown> & { type: 'merge' | 'rename' | 'move' | 'add' };

const SCRIPT = `
import json, sys
from live import mindmap
from live.models import Run
from rooms.models import Question
data = json.loads(sys.stdin.read())
run = Run.objects.get(pk=data["run"])
question = Question.objects.get(pk=data["question"])
ops = [dict(op, index=i) for i, op in enumerate(data["ops"])]
options = {"merge": True, "translate": True, "target_lang": "de", "restructure": True}
print("@@" + json.dumps({"proposal": mindmap.sign_proposal(run, question, ops, options)}))
`;

export function signedMindmapProposal(runId: number, questionId: number, ops: MindmapAiOp[]): string {
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'backend', 'python', 'manage.py', 'shell', '-c', SCRIPT],
    { cwd: REPO, input: JSON.stringify({ run: runId, question: questionId, ops }), encoding: 'utf8' },
  );
  const line = out.split('\n').find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`No proposal from the backend: ${out}`);
  return JSON.parse(line.slice(2)).proposal;
}
