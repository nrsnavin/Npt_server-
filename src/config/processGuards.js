/**
 * The last line of defence for the running API.
 *
 * Node stops the process on a promise that fails with nobody listening. Every request is handled
 * through `asyncHandler`, but a background job — a notification sent after the answer went back,
 * a timer — has no request to fail, and one missed `.catch` there would take the API down for the
 * whole office over, say, a mail server being slow. So such a failure is logged, loudly and with
 * its stack, and the API carries on serving.
 *
 * An exception thrown outside any promise is different: the process may be half-way through
 * changing something, and carrying on could serve wrong answers. That is logged and the process
 * exits, for pm2 to start a clean one in a second or two.
 */
export function installProcessGuards({ exit = (code) => process.exit(code) } = {}) {
  process.on('unhandledRejection', (reason) => {
    console.error('[process] a background task failed and nobody handled it — the API carries on:', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[process] uncaught exception — restarting:', error);
    exit(1);
  });
}
