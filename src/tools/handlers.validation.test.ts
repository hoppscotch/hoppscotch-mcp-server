import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestExecutor = vi.hoisted(() => ({
  executeRequest: vi.fn(),
  validateResponse: vi.fn(),
  formatResponse: vi.fn(),
  substituteRequestVariables: vi.fn(),
}));

vi.mock('../utils/request-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/request-executor.js')>()),
  ...requestExecutor,
}));

import { ToolHandlers } from './handlers.js';

describe('validate_response handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestExecutor.substituteRequestVariables.mockReturnValue({
      url: 'https://example.test',
      headers: {},
      body: undefined,
      substitutedSecretValues: [],
    });
    requestExecutor.executeRequest.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '{"partial":',
      responseTime: 1,
      success: true,
      truncated: true,
    });
    requestExecutor.formatResponse.mockReturnValue('formatted response');
  });

  it('renders an indeterminate result distinctly from a failure', async () => {
    requestExecutor.validateResponse.mockReturnValue({
      valid: false,
      indeterminate: true,
      errors: ['Response body is incomplete.'],
    });
    const handlers = new ToolHandlers(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await handlers.validateResponse({
      method: 'GET',
      url: 'https://example.test',
      criteria: { expectedBodyContains: ['complete'] },
    });
    const text = result.content[0].text;

    expect(text).toContain('Status: ⚠️ INDETERMINATE (body truncated)');
    expect(text).not.toContain('Status: ❌ FAIL');
    expect(text).toContain('Response body is incomplete.');
  });
});
