import type { ToolDefinition } from '@copilotkit/runtime/v2';

export type JudgeQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type JudgeAnswer =
  | { type: 'noul'; noul: number }
  | {
      type: 'choice';
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: 'score';
      score: number;
      confidence: number;
      probabilities: Record<string, number>;
    };

export type JudgeUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}

function matchesAnswer(
  type: JudgeQuestion['type'],
  answer: unknown,
): answer is JudgeAnswer {
  if (!isRecord(answer) || answer.type !== type) return false;
  if (type === 'noul') return typeof answer.noul === 'number';
  if (type === 'choice')
    return (
      typeof answer.choice === 'string' &&
      typeof answer.confidence === 'number' &&
      isNumberRecord(answer.probabilities)
    );
  return (
    typeof answer.score === 'number' &&
    typeof answer.confidence === 'number' &&
    isNumberRecord(answer.probabilities)
  );
}

function normalizeGatewayResponse(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.answers)) return value;
  const typesafe = isRecord(value.providerMetadata)
    ? value.providerMetadata.typesafe
    : undefined;
  const confidence =
    isRecord(typesafe) && isRecord(typesafe.confidence)
      ? typesafe.confidence
      : undefined;
  const answers = Object.fromEntries(
    Object.entries(value.answers).map(([key, answer]) => {
      if (!isRecord(answer)) return [key, answer];
      if (answer.type === 'boolean')
        return [key, { type: 'noul', noul: answer.probability }];
      if (answer.type !== 'choice' && answer.type !== 'score')
        return [key, answer];
      return [
        key,
        {
          ...answer,
          confidence:
            typeof confidence?.[key] === 'number' ? confidence[key] : 1,
          probabilities: answer.probabilities ?? {},
        },
      ];
    }),
  );
  return { ...value, answers };
}

export class Judge {
  private judgeKey?: string;
  private judgeModel?: string;
  private judgeGateway: boolean;
  private onUsage?: (usage: JudgeUsage) => void;

  constructor(
    config: {
      judgeKey?: string;
      judgeModel?: string;
      judgeGateway?: boolean;
      onUsage?: (usage: JudgeUsage) => void;
    },
    private fetcher: typeof fetch = fetch,
  ) {
    this.judgeKey = config.judgeKey;
    this.judgeModel = config.judgeModel;
    this.judgeGateway =
      !!config.judgeGateway || !!config.judgeKey?.startsWith('vck_');
    this.onUsage = config.onUsage;
  }

  get configured(): boolean {
    return !!this.judgeKey;
  }

  async ask<K extends string>(
    state: string | Record<string, unknown>,
    questions: Record<K, JudgeQuestion>,
    signal?: AbortSignal,
  ): Promise<Record<K, JudgeAnswer> | undefined> {
    if (!this.configured) return undefined;
    const timeout = AbortSignal.timeout(3000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const endpoint = this.judgeGateway
        ? 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model'
        : 'https://api.typesafe.ai/v1/systemone';
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.judgeKey}`,
        'Content-Type': 'application/json',
      };
      const requestQuestions = this.judgeGateway
        ? Object.fromEntries(
            (Object.keys(questions) as K[]).map((key) => {
              const question = questions[key];
              return [
                key,
                question.type === 'noul'
                  ? { type: 'boolean', instructions: question.instructions }
                  : question,
              ];
            }),
          )
        : questions;
      let body: Record<string, unknown>;
      if (this.judgeGateway) {
        headers['ai-gateway-protocol-version'] = '0.0.1';
        headers['ai-evaluation-model-specification-version'] = '4';
        headers['ai-model-id'] = this.judgeModel?.includes('/')
          ? this.judgeModel
          : 'typesafe-ai/jev';
        body = { state, questions: requestQuestions };
      } else {
        body = {
          state,
          model: this.judgeModel ?? 'jev-latest',
          questions: requestQuestions,
        };
      }
      const response = await this.fetcher(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      if (!response.ok) {
        console.warn(`Jev judgment unavailable: HTTP ${response.status}`);
        return undefined;
      }
      const parsedBody: unknown = await response.json();
      if (isRecord(parsedBody) && isRecord(parsedBody.usage)) {
        const inputTokens = parsedBody.usage.inputTokens;
        const outputTokens = parsedBody.usage.outputTokens;
        if (
          typeof inputTokens === 'number' &&
          typeof outputTokens === 'number'
        ) {
          try {
            this.onUsage?.({
              model:
                (typeof parsedBody.model === 'string' && parsedBody.model) ||
                this.judgeModel ||
                'typesafe-ai/jev',
              inputTokens,
              outputTokens,
            });
          } catch {
            console.warn('Jev usage callback failed.');
          }
        }
      }
      const responseBody = this.judgeGateway
        ? normalizeGatewayResponse(parsedBody)
        : parsedBody;
      if (!isRecord(responseBody) || !isRecord(responseBody.answers))
        throw new Error('Invalid Jev response.');
      const answers = {} as Record<K, JudgeAnswer>;
      for (const key of Object.keys(questions) as K[]) {
        const question = questions[key];
        const answer = responseBody.answers[key];
        if (!question || !matchesAnswer(question.type, answer))
          throw new Error('Invalid Jev response.');
        answers[key] = answer;
      }
      return answers;
    } catch (error) {
      if (signal?.aborted) throw error;
      const name =
        error instanceof Error &&
        [
          'AbortError',
          'TimeoutError',
          'TypeError',
          'SyntaxError',
          'Error',
        ].includes(error.name)
          ? error.name
          : 'Error';
      console.warn(`Jev judgment unavailable: ${name}`);
      return undefined;
    }
  }
}

export async function chooseModel(
  judge: Judge,
  request: string,
  models: { model: string; heavyModel?: string },
  signal?: AbortSignal,
): Promise<string> {
  if (!models.heavyModel || !judge.configured || !request.trim())
    return models.model;
  const answers = await judge.ask(
    request,
    {
      difficulty: {
        type: 'score',
        instructions:
          'How much multi-step reasoning, research, or tool use this request needs',
        criteria: [
          'Simple: greeting, short factual answer, or one obvious step',
          'Moderate: a few steps or one tool',
          'Hard: multi-step research, planning, analysis, or several tools',
        ],
      },
    },
    signal,
  );
  const difficulty = answers?.difficulty;
  if (!difficulty || difficulty.type !== 'score') return models.model;
  return difficulty.score >= 2 ||
    (difficulty.score >= 1 && difficulty.confidence < 0.6)
    ? models.heavyModel
    : models.model;
}

function isSideEffectTool(name: string) {
  if (name === 'create_space_page' || name === 'edit_space_page') return true;
  if (name === 'gmail_create_draft' || name === 'gmail_send_draft') return true;
  if (name === 'calendar_create_event') return true;
  if (!name.startsWith('computer_')) return false;
  return !['snapshot', 'read', 'list', 'status', 'screenshot'].some((word) =>
    name.includes(word),
  );
}

export function verifyToolCalls(
  tools: ToolDefinition[],
  judge: Judge,
  request: () => string,
): ToolDefinition[] {
  return tools.map((tool) => {
    if (!isSideEffectTool(tool.name) || !tool.execute) return tool;
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (args) => {
        if (judge.configured) {
          const answers = await judge.ask(
            {
              userRequest: request(),
              tool: tool.name,
              arguments: args,
            },
            {
              aligned: {
                type: 'noul',
                instructions:
                  "This tool call is needed for, and consistent with, the user's latest request.",
              },
            },
          );
          const alignment = answers?.aligned;
          if (alignment?.type === 'noul' && alignment.noul < 0.15)
            throw new Error(
              "Verification blocked this tool call because it does not appear to match the user's request. Ask the user to confirm before retrying.",
            );
        }
        return execute(args);
      },
    };
  });
}

export function latestUserText(
  messages: { role: string; content?: unknown }[],
): string {
  let message: { role: string; content?: unknown } | undefined;
  for (const item of messages) if (item.role === 'user') message = item;
  const content = message?.content;
  if (typeof content === 'string') return content.slice(0, 4000);
  if (Array.isArray(content))
    return content
      .map((part) =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string'
          ? part.text
          : '',
      )
      .join('')
      .slice(0, 4000);
  return '';
}
