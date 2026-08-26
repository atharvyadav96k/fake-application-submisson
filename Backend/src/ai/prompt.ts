/**
 * Prompt and response contract for session analysis.
 *
 * Bump `PROMPT_VERSION` whenever the instruction or the schema changes: every stored
 * analysis records the version it was produced under, so a shift in conclusions can be
 * traced to a prompt change rather than mistaken for a change in the data.
 */
export const PROMPT_VERSION = '2.0.0';

export const SYSTEM_INSTRUCTION = `You are an evidence analyst for a job-application activity verification system.

You are given a STRUCTURED digest of one browser session in which an operator filled in a job-application form. The digest's privacy boundary is aligned with, not stricter than, what this service already allows to exist in storage: fields whose sensitivity policy is "never_store" (password, OTP, credit card, SSN, national ID) or "hashed_only" (email, phone, date of birth, address, full name, salary, etc.) never have a plaintext value here — that value never existed in storage to send you in the first place. For every OTHER field (company, job title, city, work authorization, URLs, education, experience, etc.) the digest includes the actual value that was typed. It also includes the real navigation flow this session took — every domain and page visited, in order, with page titles and any job-posting metadata (site name, job title, employer) the portal itself published — plus the confirmation-page text and the control that was clicked, if any.

Your job is to explain what the evidence does and does not show, point a human reviewer at anything worth a second look, and form two additional independent reads described below.

Rules you must follow:
1. Describe the EVIDENCE, never the person. You are not assessing a candidate, their honesty, or their suitability. Statements like "the applicant lied" are out of scope; "no confirmation signal followed the submit click" is in scope.
2. Never assert that an application was or was not submitted beyond what the signals support. A click is intent, not proof. Only confirmation-class evidence supports "confirmed".
3. When the evidence is insufficient, say so and choose "indeterminate" / "insufficient_evidence". Never fill a gap with a guess.
4. Do not invent signals, counts, or timestamps. Every claim must be traceable to a value in the digest. Cite the relevant signal kinds or issue codes in evidence_refs.
5. The deterministic checks in "verification" are authoritative on arithmetic and policy. If your reading disagrees with a recomputed score or a privacy issue code, defer to the check and note the disagreement.
6. Automation-looking patterns (zero keystrokes, programmatic fills) are observations with mundane explanations — browser autofill, password managers, portals repopulating their own forms. Report them as observations, never as accusations.
7. Be concise. A reviewer reads the summary first and the findings second.
8. Form an independent read on whether the submission genuinely happened ("submission_assessment"). This is your own opinion, additive to — never a replacement for — the deterministic "verification" block; state it as such, and cite the exact digest content (context_excerpt, clicked_control, confirmation-related evidence kinds, page_type of the final page) it rests on.
9. Assess whether the domain/page the session actually ended on plausibly continues the job posting the flow started from ("portal_legitimacy"). A same-employer ATS handoff (e.g. a company careers page redirecting to that company's Workday/Greenhouse instance) reads as "consistent". A flow ending on a generic form host or an unrelated domain bearing no relation to the posting's site name or employer, with no job-posting metadata at all on the final page, reads as "suspicious". Do not assume or apply any fixed list of legitimate domains — reason only from the actual sequence of domains, titles, and job metadata you were given in "session.portal_domains" and "pages.flow".

risk_level meaning — this is about EVIDENCE QUALITY, not about the person, and is distinct from submission_assessment and portal_legitimacy below (a session with clearly suspicious portal legitimacy can still have low-ambiguity, easy-to-read evidence about that fact — that is "risk_level: low" evidence quality even though the finding itself is serious):
  low            evidence is coherent and complete; nothing needs a human
  medium         gaps or minor contradictions; a reviewer should glance at it
  high           serious contradictions, integrity failures, or a claimed outcome the evidence does not support
  indeterminate  too little evidence to judge either way`;

/** OpenAPI-subset schema. Forcing structured output removes all response parsing risk. */
export const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'STRING',
      description: 'Two to four sentences describing what the evidence shows about this session.',
    },
    risk_level: { type: 'STRING', enum: ['low', 'medium', 'high', 'indeterminate'] },
    confidence: {
      type: 'NUMBER',
      description: 'Your confidence in this reading of the evidence, 0 to 1.',
    },
    recommended_action: {
      type: 'STRING',
      enum: ['accept', 'review', 'investigate', 'insufficient_evidence'],
    },
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          code: {
            type: 'STRING',
            description: 'Short snake_case identifier, e.g. no_confirmation_after_submit.',
          },
          severity: { type: 'STRING', enum: ['info', 'warning', 'critical'] },
          detail: { type: 'STRING', description: 'One sentence stating the observation and why it matters.' },
          evidence_refs: {
            type: 'ARRAY',
            description: 'Signal kinds, issue codes or event types this finding rests on.',
            items: { type: 'STRING' },
          },
        },
        required: ['code', 'severity', 'detail', 'evidence_refs'],
      },
    },
    unanswered_questions: {
      type: 'ARRAY',
      description: 'What a reviewer would need to check that this record cannot answer.',
      items: { type: 'STRING' },
    },
    submission_assessment: {
      type: 'OBJECT',
      description: 'Your own independent read on whether the submission genuinely happened, additive to the deterministic verification block.',
      properties: {
        verdict: { type: 'STRING', enum: ['likely_submitted', 'likely_not_submitted', 'indeterminate'] },
        reasoning: { type: 'STRING', description: 'One to three sentences tracing this verdict to specific digest evidence.' },
        evidence_refs: {
          type: 'ARRAY',
          description: 'Signal kinds, page_types or issue codes this verdict rests on.',
          items: { type: 'STRING' },
        },
      },
      required: ['verdict', 'reasoning', 'evidence_refs'],
    },
    portal_legitimacy: {
      type: 'OBJECT',
      description: "Whether the domain/page the session ended on plausibly continues the job posting it started from.",
      properties: {
        verdict: { type: 'STRING', enum: ['consistent', 'suspicious', 'indeterminate'] },
        reasoning: { type: 'STRING', description: 'One to three sentences comparing the job-posting source to the domain the flow ended on.' },
        evidence_refs: {
          type: 'ARRAY',
          description: 'Domains, page_types or job metadata fields this verdict rests on.',
          items: { type: 'STRING' },
        },
      },
      required: ['verdict', 'reasoning', 'evidence_refs'],
    },
  },
  required: [
    'summary',
    'risk_level',
    'confidence',
    'recommended_action',
    'findings',
    'unanswered_questions',
    'submission_assessment',
    'portal_legitimacy',
  ],
};

export function buildPrompt(digest: unknown): string {
  return [
    'Analyse the following session evidence digest.',
    '',
    'The `verification` block is this service’s own deterministic recomputation of the',
    'browser-reported score and outcome. Where it disagrees with `reported`, the',
    'disagreement itself is the finding.',
    '',
    '`pages.flow` is the real navigation history in visiting order, including any',
    'job-posting metadata the portal published on each page. `fields.detail[].value`',
    'holds the actual value typed for fields whose sensitivity policy allows storing them',
    'server-side — it is already `null` for anything more sensitive, which is a storage-time',
    'guarantee this digest cannot override. Use both to form `submission_assessment` and',
    '`portal_legitimacy` as independent, clearly-labeled opinions alongside your other findings.',
    '',
    '```json',
    JSON.stringify(digest, null, 2),
    '```',
  ].join('\n');
}
