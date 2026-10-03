import { defineTool } from '@copilotkit/runtime/v2';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  chooseModel,
  Judge,
  latestUserText,
  verifyToolCalls,
  type JudgeQuestion,
} from '../src/server/judge.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function response(answers: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function judgeForAnswers(answers: Record<string, unknown>) {
  const fetcher = vi.fn<typeof fetch>(async () => response(answers));
  return {
    fetcher,
    judge: new Judge({ judgeKey: 'test-key' }, fetcher),
  };
}

function judgeForScore(score: number, confidence: number) {
  return judgeForAnswers({
    difficulty: {
      type: 'score',
      score,
      confidence,
      probabilities: { '0': 0, '1': 0, '2': 1 },
    },
  });
}

function judgeForNoul(noul: number) {
  return judgeForAnswers({ aligned: { type: 'noul', noul } });
}

function createTool(
  name: string,
  execute = vi.fn(async (input: { value: string }) => input.value),
) {
  return defineTool({
    name,
    description: name,
    parameters: z.object({ value: z.string() }),
    execute,
  });
}

it('sends the typed judgment request with the default model and bearer key', async () => {
  const questions = {
    route: {
      type: 'choice',
      instructions: 'Choose a route.',
      criteria: {
        technical: 'Needs technical reasoning',
        simple: 'Simple request',
      },
    },
  } satisfies Record<string, JudgeQuestion>;
  const state = { request: 'Compare these designs.' };
  const { judge, fetcher } = judgeForAnswers({
    route: {
      type: 'choice',
      choice: 'technical',
      confidence: 0.78,
      probabilities: { technical: 0.78, simple: 0.22 },
    },
  });

  const answers = await judge.ask(state, questions);

  expect(answers?.route).toEqual({
    type: 'choice',
    choice: 'technical',
    confidence: 0.78,
    probabilities: { technical: 0.78, simple: 0.22 },
  });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://api.typesafe.ai/v1/systemone');
  expect(new Headers(init?.headers).get('Authorization')).toBe(
    'Bearer test-key',
  );
  expect(JSON.parse(String(init?.body))).toEqual({
    state,
    model: 'jev-latest',
    questions,
  });
});

it('fails open for HTTP errors, network errors, and invalid answer keys or types', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const question = {
    decision: { type: 'noul', instructions: 'Judge.' },
  } satisfies Record<string, JudgeQuestion>;
  const serverError = new Judge(
    { judgeKey: 'test-key' },
    vi.fn<typeof fetch>(async () => response({}, 500)),
  );
  await expect(serverError.ask('state', question)).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalledWith('Jev judgment unavailable: HTTP 500');

  const networkError = new Judge(
    { judgeKey: 'test-key' },
    vi.fn<typeof fetch>(async () => {
      throw new TypeError('private transport detail');
    }),
  );
  await expect(networkError.ask('state', question)).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalledWith('Jev judgment unavailable: TypeError');

  for (const answers of [{}, { decision: { type: 'choice', choice: 'yes' } }]) {
    const invalid = new Judge(
      { judgeKey: 'test-key' },
      vi.fn<typeof fetch>(async () => response(answers)),
    );
    await expect(invalid.ask('state', question)).resolves.toBeUndefined();
  }
  expect(JSON.stringify(warning.mock.calls)).not.toContain(
    'private transport detail',
  );
});

it('does not fetch when unconfigured', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const judge = new Judge({}, fetcher);

  await expect(
    judge.ask('state', { decision: { type: 'noul', instructions: 'Judge.' } }),
  ).resolves.toBeUndefined();
  expect(judge.configured).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it('routes hard requests to the heavy model', async () => {
  const { judge } = judgeForScore(2, 0.9);

  await expect(
    chooseModel(judge, 'Plan a multi-step research project.', {
      model: 'base-model',
      heavyModel: 'heavy-model',
    }),
  ).resolves.toBe('heavy-model');
});

it('routes moderate requests to the heavy model only with low confidence', async () => {
  const { judge } = judgeForScore(1, 0.5);

  await expect(
    chooseModel(judge, 'Use a tool to inspect this.', {
      model: 'base-model',
      heavyModel: 'heavy-model',
    }),
  ).resolves.toBe('heavy-model');

  const confident = judgeForScore(1, 0.9);
  await expect(
    chooseModel(confident.judge, 'Use a tool to inspect this.', {
      model: 'base-model',
      heavyModel: 'heavy-model',
    }),
  ).resolves.toBe('base-model');
});

it('does not fetch for model routing when no heavy model is configured', async () => {
  const { judge, fetcher } = judgeForScore(2, 0.9);

  await expect(
    chooseModel(judge, 'A hard request.', { model: 'base-model' }),
  ).resolves.toBe('base-model');
  expect(fetcher).not.toHaveBeenCalled();
});

it('uses the base model when the Jev judgment is unavailable', async () => {
  const judge = new Judge(
    { judgeKey: 'test-key' },
    vi.fn<typeof fetch>(async () => new Response('', { status: 503 })),
  );

  await expect(
    chooseModel(judge, 'A hard request.', {
      model: 'base-model',
      heavyModel: 'heavy-model',
    }),
  ).resolves.toBe('base-model');
});

it('blocks misaligned page writes and permits aligned writes', async () => {
  const blocked = judgeForNoul(0.1);
  const blockedExecute = vi.fn(async (input: { value: string }) => input.value);
  const blockedTool = verifyToolCalls(
    [createTool('create_space_page', blockedExecute)],
    blocked.judge,
    () => 'Create a page.',
  )[0]!;
  await expect(blockedTool.execute?.({ value: 'Notes' })).rejects.toThrow(
    "Verification blocked this tool call because it does not appear to match the user's request. Ask the user to confirm before retrying.",
  );
  expect(blockedExecute).not.toHaveBeenCalled();
  const blockedRequest = JSON.parse(
    String(blocked.fetcher.mock.calls[0]?.[1]?.body),
  );
  expect(blockedRequest.state).toEqual({
    userRequest: 'Create a page.',
    tool: 'create_space_page',
    arguments: { value: 'Notes' },
  });

  const allowed = judgeForNoul(0.9);
  const allowedExecute = vi.fn(async (input: { value: string }) => input.value);
  const allowedTool = verifyToolCalls(
    [createTool('create_space_page', allowedExecute)],
    allowed.judge,
    () => 'Edit this page.',
  )[0]!;
  await expect(allowedTool.execute?.({ value: 'Updated' })).resolves.toBe(
    'Updated',
  );
  expect(allowedExecute).toHaveBeenCalledWith({ value: 'Updated' });
});

it('runs side-effect tools when Jev is unavailable and leaves read-only tools untouched', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new TypeError('unavailable');
  });
  const judge = new Judge({ judgeKey: 'test-key' }, fetcher);
  const execute = vi.fn(async (input: { value: string }) => input.value);
  const write = createTool('create_space_page', execute);
  const read = createTool('read_space_page');
  const [verifiedWrite, unchangedRead] = verifyToolCalls(
    [write, read],
    judge,
    () => 'Create a page.',
  );

  await expect(verifiedWrite?.execute?.({ value: 'Notes' })).resolves.toBe(
    'Notes',
  );
  expect(execute).toHaveBeenCalledWith({ value: 'Notes' });
  expect(unchangedRead).toBe(read);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('wraps computer actions but passes read-only computer tools through', () => {
  const judge = new Judge({ judgeKey: 'test-key' });
  const tools = [
    createTool('computer_click'),
    createTool('computer_files_write'),
    createTool('computer_exec'),
    createTool('computer_snapshot'),
    createTool('computer_screenshot'),
    createTool('computer_files_list'),
    createTool('computer_files_read'),
    createTool('computer_read'),
  ];

  const verified = verifyToolCalls(tools, judge, () => 'Use the computer.');

  for (const index of [0, 1, 2])
    expect(verified[index]?.execute).not.toBe(tools[index]?.execute);
  for (const index of [3, 4, 5, 6, 7])
    expect(verified[index]).toBe(tools[index]);
});

it('extracts the latest user string or text parts and truncates to 4000 characters', () => {
  expect(
    latestUserText([
      { role: 'user', content: 'Earlier request.' },
      { role: 'assistant', content: 'Response.' },
      { role: 'user', content: 'Latest request.' },
    ]),
  ).toBe('Latest request.');
  expect(
    latestUserText([
      {
        role: 'user',
        content: [
          { type: 'image', text: 'ignored' },
          { type: 'text', text: 'First ' },
          { type: 'text', text: 'part.' },
        ],
      },
    ]),
  ).toBe('First part.');
  expect(
    latestUserText([{ role: 'user', content: 'x'.repeat(5000) }]),
  ).toHaveLength(4000);
});
