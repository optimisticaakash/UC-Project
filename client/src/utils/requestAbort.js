export function createAbortableRequest(
  timeoutMs,
  { schedule = setTimeout, cancelSchedule = clearTimeout } = {},
) {
  const controller = new AbortController();
  let reason = null;
  let settled = false;
  const timeoutId = schedule(() => {
    if (settled) return;
    reason = "timeout";
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    cancel(cancelReason = "cancelled") {
      if (settled) return;
      settled = true;
      reason = cancelReason;
      cancelSchedule(timeoutId);
      controller.abort();
    },
    clear() {
      if (settled) return;
      settled = true;
      cancelSchedule(timeoutId);
    },
    get reason() {
      return reason;
    },
  };
}
