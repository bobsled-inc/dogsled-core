// Command-transport reviewer fixture that never reads stdin and never exits —
// exercises the timeout_s kill path. The interval keeps the event loop alive.
setInterval(() => {}, 60_000);
