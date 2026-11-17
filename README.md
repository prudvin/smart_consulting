# Smart Consulting

Web application for running a consulting company: users and sign-in, employees, customers,
employee–customer assignments, attendance, pay profiles, payroll and monthly invoicing.

Built with Node.js, Express and server-rendered EJS pages. Data is stored in a single SQLite file
using Node's built-in `node:sqlite` module, so there is no separate database server to install.

## Getting started

Requires **Node.js 22.13 or later** (Node 24 recommended).

```sh
npm install
npm start
```

Open http://localhost:3000 and sign in with **admin / admin123**, then change the password
(**Change password** in the sidebar). Set your company details under **Settings** before raising invoices.

Data is stored in `data/app.db`. Back up that file to back up everything.

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Folder for the SQLite database |
| `ADMIN_PASSWORD` | `admin123` | Password for the initial `admin` user (first run only) |
| `SESSION_SECRET` | generated and stored in the DB | Cookie signing secret |
| `COOKIE_SECURE` | off | Set to `1` when serving over HTTPS |
| `TRUST_PROXY` | off | Set when running behind a reverse proxy (nginx, IIS, etc.) |

## Features

**Users.** Administrators can add, edit, disable and remove users and reset their passwords. Users have one of two roles:
*admin*, with full access including Users and Settings, or *staff*, with everything else. You can't remove the last active admin.

**Employees.** Contact details, join date, resignation date, PAN and bank details. Designation and department are recorded on each customer assignment; lists, payslips and the details panel show the employee's current ones (from their latest started assignment). Each
employee's page shows their assignments, pay history, current-month attendance and recent payslips. If an employee
has payslips, mark them Inactive instead of deleting them.

The Employees list shows each employee's latest customer, designation and department, with filters for Status, Customer (or "No customer"), Designation and Department; changing a filter applies it straight away.

On the Employees list, click (or tap) any row to slide in a details panel from the right, with the same information as the employee page plus an **Edit** button. **Edit** opens the employee form in the same panel; **Save** returns to the details (the list refreshes when the panel closes), and **Cancel** or closing with unsaved changes asks before discarding them. Close it with ✕, Esc or a click outside. On phones the panel fills the screen. In **Recent payslips**, **View** opens the payslip in a popup over the page, with **Print / Save as PDF** (prints just the payslip) and **Open full page**. Links and buttons inside a row (Edit, email, phone) work as usual.

The **resignation date** is the employee's last working day. Entering one makes the employee **Inactive**, and the
status is locked while the date is set. They stay in leave entry, payroll and invoicing up to that date: their last
month is prorated, e.g. paid for 1–20 November, and from the next month they're left out. Their assignments stop
counting as current after that day. Clear the date to make them active again.

**Customers.** Billing address, GSTIN and contact person. On the Customers list, click a row to open the customer's details in a slide-over panel: contact and billing details, invoiced and outstanding totals, consultants assigned (upcoming ones marked), past assignments and recent invoices. **Edit** in the panel edits the customer in place.
Each customer has **Agency charges**:
- **None**: no agency line.
- **Percentage of manpower**: a percentage of the invoice's manpower lines, up to 100%.
- **Fixed amount per invoice**: a flat ₹ amount.

Generated, prefilled or rebuilt invoices add it as a separate "Agency charges" line after the manpower lines, so GST applies to it. Existing invoices are only affected if you **Rebuild** a draft.

**Assignments.** Links an employee to a customer for a date range, with the **designation** and department they work as for that customer. A new assignment is prefilled with the employee's current designation and department. Adding an assignment ends the employee's current assignment(s) the day before the new one starts; untick **End the employee's current assignment(s)** to keep them running, e.g. for someone shared between customers. There is no separate assignments page: assignments are managed from each employee's details. In the panel on the Employees list, **New assignment** and **Edit** open the assignment form in the same panel; on the full employee page they open the assignment form page, which returns to the employee after saving. On the Customers page, the consultant count opens the Employees list filtered to that customer. The dashboard lists employees "on bench",
meaning they have no current assignment.

**Billing.** Each assignment has its own billing basis and rate, billed per month (prorated for part months), per day (days worked) or per hour (hours worked). A new assignment starts with the employee's latest billing basis and rate. Assignments without a rate are billed at ₹0 and named in a warning when invoices are generated.

**Attendance.** Attendance is entered per month, and there is a single leave type, **Leave**, which is unpaid.
There are two tabs, Monthly entry and Leave register:
- *Monthly entry*: enter the **leave days** each employee took in the month. Leave is unpaid. Every other weekday
  (Monday–Friday, from the joining date) counts as worked. The page shows paid days and days worked live, and rejects
  more leave than working days. Buttons fill empty rows from the daily records, or with 0 leave.
  An employee's monthly entry replaces their daily records for that month in payroll and invoicing. A blank entry
  uses the daily records if there are any; with no records at all it means no leave.
- *Finalizing per customer*: the Customer attendance section of Monthly entry lists each customer with consultants
  that month as **Open** or **Finalized**. **Finalize** locks the leave days of that customer's consultants for the
  month. An employee who worked for more than one customer is locked if any of them is finalized. Only an admin can
  **Reopen** a customer. Generating a month's invoices warns about customers whose attendance isn't finalized yet,
  but doesn't block it.
- *Daily sheet*: hidden from the menus, since attendance is entered monthly. Existing daily records still apply
  to months without a monthly entry, and the sheet remains at `/attendance/daily` if ever needed.
- *Leave register*: leave days per employee for each month of a financial year (April–March), with employee and
  month totals. Click a month to enter its leave.

With monthly leave days:
- Salary is paid for **days employed − leave days**.
- Customers on daily rates are billed **working days − leave days**, and on hourly rates 8 hours per day worked.
- If an assignment covers only part of the month, it carries a proportional share of the month's leave.
- Public holidays are not deducted from working days.

Older day-by-day records are read the same way: leave and absent days each count as a day of leave, and a half day
as half a day. Holidays, week offs and unmarked days are paid.

**Pay profiles.** These are salary structure templates made of earning and deduction components. Each component is a
fixed amount, a % of gross, a % of basic (the earning named "Basic"), or the balance of gross (one earning only).
A "Standard" profile is created on first run. The edit page shows a worked example.

**Employer contributions.** A component can be an *Earning* (added to pay), a *Deduction* (taken from pay) or an
*Employer contribution*. Employer contributions are a company cost: they appear on payslips, in payroll and in the CSV
with a cost-to-company total, but don't reduce net pay.

**EPF and ESI.** Use the **EPF** and **ESI** calculations on a deduction (employee share) or an employer contribution:

| | Employee (deduction) | Employer contribution | Calculated on | Rounding |
| --- | --- | --- | --- | --- |
| EPF | 12 | 13 (12% + 0.5% admin + 0.5% EDLI) | PF wages: earned Basic, capped at the PF wage ceiling (Settings, default ₹15,000; 0 = no cap) | Nearest rupee |
| ESI | 0.75 | 3.25 | Gross earned, only if the monthly gross is ₹21,000 or less | Up to the next rupee |

A basic above the PF wage ceiling is counted as the ceiling, e.g. 12% of ₹15,000 = ₹1,800 for any basic over ₹15,000.
EPF and ESI can also be set up as earnings (paid to the employee on top of salary), calculated the same way. A component
named like EPF/PF that uses "% of basic" is rejected, so the ceiling can't be bypassed by accident.

ESI eligibility is checked each month against the employee's monthly gross. The rule that keeps an employee covered
for the rest of a contribution period after crossing ₹21,000 is not applied.

**Professional tax.** Use the **Telangana PT slab** calculation on a deduction. It applies the
[Telangana professional tax schedule](https://www.tgct.gov.in/tgportal/AllActs/APPT/APPTSchedule.aspx) (entry 1,
salary and wage earners) to the gross earned in the month, after leave/LOP proration:

| Monthly salary or wage | PT per month |
| --- | --- |
| Up to ₹15,000 | Nil |
| ₹15,001 – ₹20,000 | ₹150 |
| Above ₹20,000 | ₹200 |

To exempt an employee, tick **Exempt from professional tax** on their record, e.g. for 40% or more disability under
the schedule's exemptions. Slabs are defined in `src/constants.js` (`TELANGANA_PT_SLABS`), so update them there if the
schedule changes.

**Employee salary.** Lists every employee, including inactive ones and anyone without a pay profile yet, with the
customers they're currently assigned to (or "On bench"), their current pay profile, monthly gross and the date it
took effect. The search box filters as you type, by name, code, designation, customer or pay profile, and the
Designation, Customer (including "On bench") and Pay profile dropdowns narrow the list further; **Clear** resets them.
Click any column header to sort by it, and click again to reverse. An upcoming change is flagged. The pencil icon opens a
popup to set the pay profile, monthly gross and effective-from date. Saving adds a pay record from that date, so earlier
payroll keeps the old pay; a record already starting on that date is updated instead. Payroll uses the latest record
effective on or before the month end. An employee's full pay history is on their employee page.


**Payroll.** Generates payslips for a month:
- `paid days = days employed in month − loss-of-pay days`. Days before the join date are unpaid.
- Earnings are the full-month amounts × paid days ÷ days in month.
- Percentage deductions are calculated on the prorated earnings. Fixed deductions, such as professional tax, apply in full.

**Regenerate**, on the payroll list or a run, or generating a month that already has payroll, clears the existing run
and all its payslips, then generates the month again as a new draft from the current pay profiles, employee salaries and
attendance. You're asked to confirm first. Finalizing protects a run: only an admin can regenerate or reopen a finalized month.

**Payroll needs finalized attendance.** An employee assigned to a customer in the month gets a payslip only once that
customer's attendance is finalized (any one of their customers, if they worked for more than one). Employees not
assigned to any customer that month are always included. The message after generating lists how many employees were
left out per open customer; finalize those customers and regenerate to add them. If nobody's attendance is final,
nothing is generated and an existing run is left untouched.
On the run page, click a row to open that employee's payslip in the slide-over panel (with **Print / Save as PDF**, which prints just the payslip), or click the employee's name to open their details. The run page shows every earning and deduction component as its own column, grouped under Earnings and Deductions,
with column totals. "—" marks a component that isn't in that employee's pay profile. Each run has printable payslips
and a CSV export with the same component columns, plus bank details for salary upload.

**Invoices.** **Generate invoices** creates one draft per active customer that had assignments in the month.
Customers already invoiced for that month are skipped. There is one invoice line per designation: the quantity is the
number of resources and the amount is what they are billed for the month (monthly, daily or hourly, prorated as
applicable), e.g. "Senior Consultant · Qty 2 · ₹7,00,000". Lines have no rate column. Designations without a rate on
the assignment are billed at ₹0 and flagged.

Each generated invoice carries an **annexure**, printed as a separate page after the invoice and also available as a CSV.
For each employee it shows the designation, project role, the payroll components from their payslip for the invoice month
(earnings and gross, deductions and their total, net pay, and employer contributions), and the billed amount.
Subtotals per designation match the invoice lines. Below the table, a statutory summary gives the totals of Employee PF,
Employer PF, ESI and PT (with the number of employees for each). They are
recognised by component name (e.g. "PF Employee Contribution", "PF Employer Contribution", "ESI", "PT"): a PF component
is the employer's share when its name says "Employer" (or it is an employer contribution), otherwise the employee's.
ESI is split into employee and employer shares when the component names say so.
The payroll figures are read from the month's payroll run when the annexure is shown, so run payroll for the month first;
they can change until that payroll is finalized.

You can also create an invoice manually. Drafts are editable: line items, dates, CGST and SGST rates, and notes.
GST is charged as two components, CGST and SGST (9% each by default, set under Settings), on the manpower lines plus agency charges. **Rebuild**
regenerates a draft's lines and annexure from current assignments, rates and attendance. The status moves through
Draft → Sent → Paid (or Cancelled). Invoices print or save as PDF from the browser. Numbers follow
`<prefix><YYYYMM>-<seq>`, e.g. `INV-202610-001`.

## Development

```sh
npm run seed   # load demo customers, employees, assignments, attendance and pay (empty database only)
npm start      # runs the app and restarts it automatically when code changes
npm run start:once  # runs the app without watching for changes (e.g. on a server)
npm run dev    # same as npm start
npm test       # payroll and invoice calculation tests
```

The app works on phones and tablets. Below 820px wide, the sidebar becomes a slide-in menu behind a ☰ button in a
top bar. Forms and filters stack, wide tables scroll sideways inside their box, and invoices and payslips reflow to fit
(printing is unchanged). On touch screens, buttons are larger and inputs use 16px text so phones don't zoom in.

The colour theme (gold) is set by the variables at the top of `public/style.css`, e.g. `--primary`, `--gold` and `--sidebar`.
The company logo is `public/logo.png`. It appears in the sidebar, on the login page, on invoices and payslips, and as
the browser tab icon. Replace that file, keeping the same name, to change it.

Project layout:

```
src/
  server.js            app setup and route mounting
  db.js                schema, settings, first-run seed
  services/payroll.js  payslip calculation and payroll runs
  services/invoices.js invoice line building and numbering
  routes/              one file per section
views/                 EJS templates
public/                CSS and a small client-side script
test/                  node:test tests
```

## Notes and limitations

- GST is split into CGST and SGST only. IGST (inter-state supply) is not supported.
- Payroll does not calculate income tax (TDS), ESI or PF wage ceilings. Model them as fixed or percentage
  deduction components on a pay profile.
- Sign-in has no rate limiting. If the app is exposed to the internet, put it behind HTTPS
  (`COOKIE_SECURE=1`) and a reverse proxy.
