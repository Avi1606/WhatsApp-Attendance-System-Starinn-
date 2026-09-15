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
- `refresh staff` - reload staff from Google Sheets `Master Staff Data` tab immediately
- `staff status` - view active and left staff count and office breakdown
- `staff left <employee name> [DD/MM/YYYY]` - mark an employee as Left directly in Google Sheets

Employee names can be managed directly in the `Master Staff Data` sheet without redeploying.

## Dynamic Staff Management (`Master Staff Data`)

The bot directly uses the **`Master Staff Data`** tab in Google Sheets as the single source of truth for employees.

- **Add Staff:** Simply add a new row in `Master Staff Data` with Name, Phone, Office Location, Role, etc.
- **Staff Left:** Either change `Status` to `Left` and add `Left Date`, or write `Left` in `Remarks`, or send `staff left <Name>` from WhatsApp.
- **Zero Deployment:** Changes in Google Sheets take effect automatically (cached for 2 minutes, or immediately by sending `refresh staff` on WhatsApp).
- **Auto-Protection for Ex-Staff:** Former employees who have left are automatically excluded from daily absent marking (`auto-absent`) and reminder messages. If an ex-employee messages the bot, they receive an inactive profile notice.

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
| 09:00 next day | `POST /jobs/daily-report` | Send the previous day's admin summary |
| 09:15 next day | `POST /jobs/location-daily-report` | Send the previous day's office-wise Absent, No OUT, Late, and Half Day reports to seniors |
| 23:00 | `POST /jobs/auto-absent` | Add Absent rows for employees with no record |
| Monthly | `POST /jobs/salary-report` | Send salary-cycle report to employees |

Each job is also guarded in-process so the same job/date is skipped if the same server instance receives duplicate scheduler calls.

For external schedulers, you can add `?quiet=1` to return no response body:

```text
POST /jobs/auto-absent?quiet=1
```

This helps avoid scheduler errors such as "response data too long".

The main absent endpoint can be scheduled every day:

```text
POST /jobs/auto-absent?quiet=1
```

It checks all employees every day, including Sunday. It still skips dates listed in `holidays`.

Office-wise senior reports use `officeManagers` from `config.json`:

```json
"officeManagers": {
  "South Ex Office": [
    "whatsapp:+919899242080"
  ],
  "OPC": [
    "whatsapp:+917042926825"
  ],
  "Jasola Office": [
    "whatsapp:+918780901324",
    "whatsapp:+918010430524"
  ],
  "Noida Office": [
    "whatsapp:+919899242080"
  ]
}
```

### Daily Report WhatsApp Commands

- **For Office Managers**:
  - `daily report` / `office report`: Sends yesterday's daily report for their assigned office directly in WhatsApp.
  - `daily report today`: Sends today's live daily report.
- **For Admins Only**:
  - `send daily report`: Automatically sends yesterday's daily report to **all** configured office managers.
  - `send daily report <office>`: Automatically sends yesterday's daily report to that **particular office's managers only** (e.g. `send daily report South Ex`, `send daily report OPC`, `send daily report Jasola`, `send daily report Noida`).
  - `send daily report [office] today`: Sends today's report to the specified office managers or all offices.
  - Reports are sent **only to configured office managers and no one else**. Jim Corbett staff are kept in records only and excluded.

If Twilio returns `Error 63016: Outside messaging window`, configure an approved WhatsApp content template SID for scheduled jobs:

```json
"scheduledWhatsAppContentSid": "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

When set, the bot sends scheduled report text through that template using a single template variable. This is required for proactive WhatsApp messages that are outside the 24-hour customer care window.

Salary report cycle is from the 20th to the 20th. For example, if the job runs on August 26, it reports July 20 to August 20. The salary report can read optional sheet columns named `Salary` or `Monthly Salary`, `Max Leaves`, and `Fine`. You can also keep salary/fine values in `config.json`:

```json
"employeeSalaries": {
  "whatsapp:+918780901324": 30000
},
"employeeFines": {
  "whatsapp:+918780901324": 500
}
```

No OUT marked days are counted as absent/not payable in the salary report.

## Google Sheet schema

The bot writes attendance data in columns `A:J`:

```text
Name | Date | IN | OUT | Status | Employee ID | Last Message SID | Remarks | Late | Office Location
```

Older rows with only `A:E` still work by matching employee name, but new writes include Employee ID, Message SID, Remarks, Late, and Office Location.

For salary reports, you can add extra columns after `J`, such as:

```text
Max Leaves | Salary | Fine
```

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
