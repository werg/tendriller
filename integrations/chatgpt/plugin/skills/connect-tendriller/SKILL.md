---
name: connect-tendriller
description: Help a Tendriller user link their account, approve an application, and verify the connection from ChatGPT.
---

# Connect Tendriller

1. In the current chat, call `list_tendrils`. If ChatGPT asks the user to connect,
   have them follow its sign-in prompt, use their usual Tendriller GitHub or Google
   identity, and review **Connect ChatGPT**. Give one step at a time. Keep
   credentials and authorization codes out of the chat.
2. If the list is empty, ask which app they want to use and whether it is already
   claimed under that account. The agent running the app must enable the assistant
   adapter. Give the owner the review URL returned by the participant or help them
   find a pending review in [Tendriller connections](https://tendriller.dev/connections).
   Use [Connect any application](https://tendriller.dev/docs/CLOUDFLARE_ASSISTANT.md)
   for participant setup. The owner chooses the queries, commands, and events to share.
3. Refresh the app list. Use `describe_application` to learn the selected app's
   approved capabilities. Verify the link with a relevant read. Execute a write
   only if requested, and verify the applied result with a fresh read. Keep the
   original operation ID and input for uncertain retries.
4. If the app is offline, ask its operator to resume the enrolled participant from
   its existing device store. If the person wants to catch up, use
   `read_application_events` and keep its cursor. Verify a supported ChatGPT Work
   subscription before promising background delivery.

For user-facing links and setup recovery, use the [ChatGPT setup guide](https://github.com/werg/tendriller/blob/master/docs/CHATGPT_INTEGRATION.md#link-and-verify).
Users can revoke a link at [Connected integrations](https://tendriller.dev/oauth/connections).
