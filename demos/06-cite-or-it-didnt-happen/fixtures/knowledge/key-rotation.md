# API key rotation policy

Production API keys are rotated every 90 days. Rotation is automated by the
`keyctl` cron job, which mints a new key, deploys it to the secret store, and
revokes the previous key after a 24-hour overlap window.
