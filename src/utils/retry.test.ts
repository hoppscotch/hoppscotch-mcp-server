import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryWithBackoff } from './retry';

/** Node surfaces transient network failures as an Error carrying a `code`. */
const codedError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return result on first try if successful', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await retryWithBackoff(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable errors', async () => {
    const error1 = codedError('Connection timeout', 'ETIMEDOUT');
    const error2 = codedError('Connection reset', 'ECONNRESET');

    const fn = vi
      .fn()
      .mockRejectedValueOnce(error1)
      .mockRejectedValueOnce(error2)
      .mockResolvedValue('success');

    const result = await retryWithBackoff(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
    });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should not retry on non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid input'));

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 10,
      })
    ).rejects.toThrow('Invalid input');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should exhaust retries and throw last error', async () => {
    const error = codedError('Connection timeout', 'ETIMEDOUT');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 2,
        initialDelay: 10,
      })
    ).rejects.toThrow('Connection timeout');

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('should handle timeout errors', async () => {
    const error = new Error('Request timeout');
    error.name = 'TimeoutError';

    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('success');

    const result = await retryWithBackoff(fn, {
      maxRetries: 2,
      initialDelay: 10,
    });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should handle AbortError', async () => {
    const error = new Error('Request aborted');
    error.name = 'AbortError';

    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('success');

    const result = await retryWithBackoff(fn, {
      maxRetries: 2,
      initialDelay: 10,
    });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
