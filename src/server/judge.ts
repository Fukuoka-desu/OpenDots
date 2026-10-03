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

export class Judge {
  private judgeKey?: string;
  private judgeModel?: string;

  constructor(
    config: { judgeKey?: string; judgeModel?: string },
    private fetcher: typeof fetch = fetch,
  ) {
    this.judgeKey = config.judgeKey;
    this.judgeModel = config.judgeModel;
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
      const response = await this.fetcher(
        'https://api.typesafe.ai/v1/systemone',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.judgeKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            state,
            model: this.judgeModel ?? 'jev-latest',
            questions,
          }),
          signal: requestSignal,
        },
      );
      if (!response.ok) {
        console.warn(`Jev judgment unavailable: HTTP ${response.status}`);
        return undefined;
      }
      const responseBody: unknown = await response.json();
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
