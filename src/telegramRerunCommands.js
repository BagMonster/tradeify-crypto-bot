export function registerRerunCommands({
  bot,
  service,
  withAuthorization,
  sendLatched
}) {
  bot.onText(/^\/re-?run(?:@\w+)?$/i, withAuthorization(async (message) => {
    const result = await service.requestRerun();
    await sendLatched(message.chat.id, "/re-run", result.message);
  }));

  bot.onText(/^\/confirmre-?run(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/confirmrerun", await service.confirmRerun(match?.[1] ?? ""));
  }));
}
