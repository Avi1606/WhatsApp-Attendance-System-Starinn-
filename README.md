# WhatsApp Attendance Bot

Express service for marking employee attendance from WhatsApp messages through Twilio and storing records in Google Sheets.

## What this version includes

- Twilio webhook signature validation for `/webhook`
- Config moved out of source code into `config.json` and environment variables
- Google Sheet writes use a stable Employee ID column, not only employee names
- Idempotency with Twilio message SIDs to avoid duplicate writes on retries
- OUT-before-IN protection
- External, secret-protected job endpoints instead of an in-process scheduler
- Tests for date handling, config validation, and attendance sheet writes

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local secret files:

   - `config.json` with employee WhatsApp numbers, names, Sheet ID, admin number, and Twilio sender.
   - `.env` or `password.env` with Twilio credentials, `CRON_SECRET`, and Google credentials path.

   These files are intentionally not uploaded to GitHub.

3. Google credentials:

   Set `GOOGLE_APPLICATION_CREDENTIALS=./credentials.json` or point it to wherever your service-account key is stored.

   `credentials.json` is intentionally git-ignored. If this key was ever committed or shared, rotate it in Google Cloud.

4. Start locally:

   ```bash
   npm start
   ```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token; also used to validate webhook signatures |
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | Path to Google service-account JSON |
| `CRON_SECRET` | Yes | Bearer token for job endpoints |
| `CONFIG_PATH` | No | Defaults to `./config.json` |
| `PORT` | No | Defaults to `3000` |
| `TRUST_PROXY` | No | Set `1` when behind a proxy/tunnel/load balancer |
| `TWILIO_VALIDATE_WEBHOOK` | No | Defaults to `true`; set `false` only for local Postman/curl testing |

## WhatsApp commands

Employees can send:

- `in` - mark office IN for today
- `out` - mark office OUT for today
- `status` - see today's attendance status
- `report` - see current month summary only when `reportsEnabled` is `true`
- `help` - list commands

Admins can also send:

- `mark in <employee name>`
- `mark out <employee name>`
- `mark in <employee name> DD/MM/YYYY`
- `mark out <employee name> YYYY-MM-DD`

Employee names must be unique in `config.json`.

## Monthly report hold

Monthly reports are paused by default:

```json
"reportsEnabled": false
```

When you want to activate reports before salary slip preparation, change it to:

```json
"reportsEnabled": true
```

Then restart the app. Until this is enabled, users who send `report` will receive a polite "report is on hold" message.

## Twilio webhook

Configure the Twilio WhatsApp inbound webhook to:

```text
POST https://your-public-domain.example/webhook
```

Signature validation depends on the exact public URL Twilio calls. If you use ngrok, Cloudflare Tunnel, Render, Railway, or another proxy, set `TRUST_PROXY=1` and make sure the public URL in Twilio matches the actual request URL.

## Scheduled jobs

Use an external scheduler such as cron-job.org, GitHub Actions, Google Cloud Scheduler, or your hosting provider's cron feature.

Every request must include:

```text
Authorization: Bearer <CRON_SECRET>
```

Suggested schedule in `Asia/Kolkata`:

| Time | Endpoint | Purpose |
| --- | --- | --- |
| 10:30 | `POST /jobs/morning` | Remind employees who have not marked IN |
| 19:00 | `POST /jobs/forgot-out` | Remind employees who marked IN but not OUT |
| 21:00 | `POST /jobs/daily-report` | Send admin daily summary |
| 23:00 | `POST /jobs/auto-absent` | Add Absent rows for employees with no record |

Each job is also guarded in-process so the same job/date is skipped if the same server instance receives duplicate scheduler calls.

For external schedulers, you can add `?quiet=1` to return no response body:

```text
POST /jobs/auto-absent?quiet=1
```

This helps avoid scheduler errors such as "response data too long".

## Google Sheet schema

The bot uses columns `A:G`:

```text
Name | Date | IN | OUT | Status | Employee ID | Last Message SID | Remarks | Late | Office Location
```

Older rows with only `A:E` still work by matching employee name, but new writes include Employee ID and Message SID.

New attendance rows are inserted directly below the header at row 2, so the newest record stays at the top.

`Remarks` is marked as `Half Day` when:

- IN is after `11:00`
- or OUT is before `17:00`

`Late` is marked as `Late` when:

- IN is after `10:15`

When configured, `Office Location` is filled from `employeeLocations` in `config.json`:

```json
"employeeLocations": {
  "whatsapp:+918780901324": "Delhi Office"
}
```

Employees who should not have time-based `Remarks` or `Late` can be added to:

```json
"timeExemptEmployees": [
  "whatsapp:+918780901324"
]
```

These employees can still mark IN/OUT normally, but `Remarks` and `Late` stay blank.

## Testing auto replies locally

For local testing without Twilio's signature header, set this in `password.env` or `.env`:

```env
TWILIO_VALIDATE_WEBHOOK=false
```

Restart the app, then send a form request to:

```text
POST http://localhost:3000/webhook
Content-Type: application/x-www-form-urlencoded
```

Example body:

```text
From=whatsapp:+918780901324&Body=hi&MessageSid=TEST-HI-1
```

Set `TWILIO_VALIDATE_WEBHOOK=true` again before using the real Twilio webhook.

To change the auto-reply text, edit the formatter functions in `src/app.js`, especially `formatWelcome`, `formatAttendanceMarked`, `formatStatus`, and `formatMonthlyReport`.

## Verification

```bash
npm test
npm run check
npm audit
```
