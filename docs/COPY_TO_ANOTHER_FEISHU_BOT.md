# Connect another Feishu app

The application code can be reused with another enterprise custom app. Supply that app's own credentials, Verification Token, optional Encrypt Key, target group, mention name and owner user IDs in a private `.env` file.

Enable the bot capability, subscribe to `im.message.receive_v1`, configure the HTTPS `/feishu/events` callback, grant the required scopes, publish the app and add it to the intended group. Confirm document authorization and restart the service after configuration changes.

Do not copy another app's secrets or runtime state into a public repository. Review the complete [Setup guide](SETUP.md), [Deployment guide](PRODUCTION_DEPLOYMENT.md), and [Security policy](../SECURITY.md).
