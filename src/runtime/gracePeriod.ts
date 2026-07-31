export async function withGracePeriod(
  operation: Promise<void>,
  graceMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`shutdown exceeded ${graceMs}ms grace period`)),
          graceMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
