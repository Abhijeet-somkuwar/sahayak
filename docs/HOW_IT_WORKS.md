# How Sahayak works

To try it hands-on first, open http://localhost:5173/demo (the guided demo, see [DEMO_GUIDE.md](DEMO_GUIDE.md)).

A plain-language guide to the whole system: who uses it, what each screen does, and what happens behind the scenes. Use it to explain the product to hospital staff, patients, or anyone watching a demo. No programming knowledge is needed; the "Behind the scenes" notes are there so you can answer "but how does it know?" questions.

---

## 1. The one-minute version

Sahayak is the front door of a government hospital's OPD (out-patient department).

1. A **patient** starts a visit on their phone (or on WhatsApp, or at a kiosk). The app asks a few questions, checks for danger signs, and books them into the right department.
2. At the hospital **gate**, they scan their booking QR at a kiosk and get a **token number**. People without a phone register at the **counter**.
3. The **doctor** presses "Call next". The system picks the fairest next patient and shows the doctor a short **pre-brief** before the patient walks in.
4. The **waiting-hall TV** and the patient's own phone show "Your turn, go to Room 1" within a second.
5. Emergencies never wait in the OPD queue. They are sent straight to **Casualty**, and the casualty team is alerted.

An AI model helps understand what the patient wrote, picks the department, and writes the doctor's summary. Everything safety-critical (who is an emergency, who goes first, every word a patient reads) is decided by clinician-written rules and templates, not by the AI. If the AI is switched off, the whole flow still works.

---

## 2. Who uses it and where

| Person | Screen | Address (development) | Signs in with |
|---|---|---|---|
| Patient on a phone | Facility page, start a visit, slip | `http://localhost:5173/f/GJ-DEMO-DH` | mobile number + OTP code (shown on screen in development) |
| Patient at the gate | Kiosk | `http://localhost:5173/kiosk` | nothing (the kiosk itself has a device key) |
| Everyone in the waiting hall | TV display | `http://localhost:5173/display` | nothing (device key) |
| Registration clerk, help desk | Counter | `http://localhost:5173/counter` | `clerk@demo.sahayak.health` / `Demo@12345678` |
| Doctor | Doctor console | `http://localhost:5173/doctor` | `dr.mehta@demo.sahayak.health` / `Demo@12345678` + authenticator code |
| Doctors, nurses, admins | Casualty board | `http://localhost:5173/ed` | same as doctor |
| Hospital admin, state admin, clinical reviewers, data protection officer | No screen yet: the API only | `http://localhost:3000/api/v1/docs` | their email + password + authenticator |

All staff sign in at `http://localhost:5173/login`. The staff screens lock after 10 minutes without activity and ask for the password again.

**Demo hospital.** "Demo District Hospital", Gujarat, facility code `GJ-DEMO-DH`.

| Department | Token prefix | Room | Doctor(s) |
|---|---|---|---|
| Medicine OPD | MED | Room 1, ground floor | Dr. Anil Mehta, Dr. Ritu Shah |
| Paediatrics OPD | PED | Room 2, ground floor | Dr. Kiran Patel |
| Women's OPD (Gynaecology and Obstetrics) | OBG | Room 3, first floor | Dr. Meera Desai |
| Orthopaedics OPD | ORT | Room 4, first floor | Dr. Vikram Joshi |
| Eye OPD | EYE | Room 5, first floor | Dr. Nita Parikh |
| ENT OPD | ENT | Room 6, first floor | Dr. Sunil Trivedi |
| Casualty (Emergency) | EMR | Casualty Bay | Dr. Lakshmi Rao |

OPDs run Monday to Saturday, 9:00 to 13:00 (Eye OPD to 12:30). Registration opens at 8:00. On a Sunday the facility page shows every department as "closed today".

Other demo logins (all with the same password): `admin@`, `nurse@`, `helpdesk@`, `reviewer1@`, `reviewer2@`, `dpo@`, `state@` and the seven other doctors, all `…@demo.sahayak.health`. Doctors, admins, reviewers and the DPO must also enter a 6-digit authenticator code.

**Where the authenticator code comes from.** It is a time-based one-time password (TOTP), the kind Google Authenticator, Authy or Microsoft Authenticator produce; it changes every 30 seconds and the server knows the same secret.

In development there is nothing to install: once the password is accepted, the sign-in screen itself shows "Development mode: your authenticator code is 123456" with **Copy** and **Sign in with this code** buttons. The backend hands the code out only when it is not running in production (the same rule as the patient OTP code). Otherwise, three situations:

| Situation | What to do |
|---|---|
| The account has never signed in (most doctors, the reviewers) | The sign-in screen shows a QR code and, under "Can't scan?", the same key as text. Scan it with the authenticator app on your phone, then type the 6-digit code the app shows. From then on the phone app is the source of codes. |
| The account was enrolled by the backend's smoke test (`dr.mehta@`, `admin@`, `dpo@`, `state@`) | No QR is shown because the account is already enrolled; the secret is in the git-ignored file `backend/.smoke-totp.json`. Run `npm run totp` at the project root to print the current code for each of them, or `npm run totp -- dr.mehta@demo.sahayak.health` for one. You can also type that secret into a phone app by hand ("Enter a setup key"). |
| Enrolled on a phone you no longer have | `npm run totp -- --reset <email>` clears the enrolment (the Docker Postgres must be running); the next sign-in shows the QR code again. |

Three **devices** exist: "Main Hall Display" (shows Medicine, Paediatrics and Women's OPD), "Gate Kiosk" and "Counter 1 Terminal". Each has a secret key, kept in `backend/.demo-device-keys.json`. The kiosk and display ask for it once and remember it on that device (kiosk and display keys are stored separately, so both can run in one browser). In development the setup screen offers a "Use the demo key" button, and the Demo button lists all keys.

---

## 3. The patient's journey on a phone

### 3.1 Facility page

The patient opens `…/f/GJ-DEMO-DH` (in real life from a QR poster at the hospital). They see:

- "Welcome", a big **Start a visit** button.
- **I already have a slip**: type the code on a slip to reopen it.
- **Departments today**: each department with "closed today" or "12 waiting · 15–25 min", live.
- Language (English / हिंदी / ગુજરાતી), text size and high-contrast switches. These are remembered on the phone.

### 3.2 Sign in with a mobile number

Start a visit asks for a mobile number and sends a 6-digit code. In development no SMS is sent; the code is printed on the screen under "Development mode: your code is". One phone can be used for a whole family (see "Who is this visit for?").

### 3.3 The conversation

The intake is a chat with the **Sahayak assistant** (marked "AI"): one question at a time, answered with buttons, a list, typed text, or a voice note, with earlier answers kept as chat bubbles. After the patient describes the problem, the assistant shows **"Here is what I understood"** (the matched symptoms and how long), and the booking ends with **"How Sahayak decided"**: urgency and why, the department and how it was chosen, and "This is not a diagnosis". These cards show structured results (catalogue symptom names, the rules' urgency, the department), never AI-written text, and never a guessed disease: India's Telemedicine Practice Guidelines let AI assist only the doctor. The exact same questions are asked on WhatsApp.

| Step | What the patient sees | Behind the scenes |
|---|---|---|
| Consent | A short notice: data stays in India, is shared only with this hospital. **I agree** / No. | Saying No ends the conversation politely ("please visit the registration counter"). The consent, its version, language and channel are recorded. |
| AI consent | "May we use a computer assistant to understand your symptoms? It never gives medical advice; a doctor always decides. If you say No, we will ask simple menu questions instead." | No switches the whole intake to **menu mode**: no AI call is made for this patient. |
| Who is this visit for? | The people already linked to this phone, or **Someone else** → name, sex, age, relationship (parent, child, spouse, ASHA worker, caregiver…). | A household is built around the phone number. Family members and ASHA workers can register others. |
| What do you need today? | **New health problem** · **Follow-up visit** · **Collect a report** · **Question about hospital** · **Emergency now** | "Collect a report" answers with the lab counter timings and ends. "Question" opens the knowledge bot (section 7). "Emergency now" goes straight to the emergency outcome. |
| Describe the problem | Free text or voice: "burning in the stomach for 3 days", "pet mein jalan hai 3 din se". | **Emergency pre-screen first**: the text is checked against a clinician-maintained phrase list (chest pain, can't breathe, unconscious, fits, heavy bleeding, snake bite, poison, stroke, labour pain… in English, Hindi, Gujarati and Hinglish). A match ends the intake with the emergency outcome before anything else happens. Self-harm words trigger a dedicated crisis response (Tele-MANAS 14416, 112) and a staff alert. Then the text is **de-identified** (phone numbers, names, ids removed) and the AI maps it to symptom codes from a 159-symptom catalogue. If the AI is off or unsure, the patient instead picks a body area (Stomach, Breathing / cough, Skin, Injury…) and then a symptom from a list. |
| A few questions | "Since when?", "How bad is the pain, 0–10?", "Are you breathless even while sitting?", "Any blood in the vomit?"… at most 5. "Question 2 of about 5" shows progress. | The questions come from a vetted bank of 40. Only questions that matter for this patient's symptoms are asked, and only until the rules have what they need. Every free-text answer is re-checked by the emergency pre-screen. |
| Risk | Pregnancy (women 12–50), long-term illness (Diabetes, High BP, Asthma/COPD, Heart disease, Kidney disease, TB, None; pre-filled from the record if known), disability or help to walk. | These decide the **protected lane** and raise urgency (for example any acute problem in pregnancy is priority). |
| Triage | Nothing visible; takes under a second. | The **rules engine** evaluates every rule in the published rule set and gives a level: **emergency**, **priority**, **routine** or **self-care**. The AI can only make the result *more* urgent, never less. Then the department is chosen (section 5). |

### 3.4 The three outcomes

**Emergency.** A red full-screen message: "This may be an emergency. Go to Casualty now (Casualty Bay) or call 108. The casualty team has been alerted. Do not wait for an OPD token." A **pre-alert** appears on the Casualty board with the patient's age band, sex and the red flags that fired. No OPD booking is made.

**Self-care.** "Based on what you told us, this can usually be managed at home", followed by the hospital's own reviewed leaflet (for example the common-cold leaflet) and the warning signs that should bring them in. A **Book a visit anyway** button is always there. Self-care is only possible for a short list of mild complaints (cold, sore throat, body ache, constipation, bloating, insect bite, acne, muscle cramp, sprain, hiccups), for under 3 days, and never for children under 5, people over 60, pregnant women, or anyone with a long-term illness.

**OPD booking** (the normal case). "Your visit is booked", with:

- the department and room,
- a **reporting window**: "Please arrive between 10:00 and 10:30",
- an expected wait after check-in, always a range, for example "15–25 minutes",
- "You will be seen in the priority lane" when triage said priority,
- a **QR code** and **Open my slip**.

The patient does **not** get a token number yet. The number is given only when they physically arrive and check in. This is deliberate: it stops people booking from home and blocking the queue, and it rewards arriving on time (anyone who checks in within their window is placed in the queue as if they arrived at the start of the window).

---

## 4. At the hospital

### 4.1 The gate kiosk

A tablet in portrait mode, bilingual, no sign-in. "Scan your QR code" with a live camera view. The patient holds up the booking QR (or types the check-in code if there is no camera). The kiosk then:

1. checks the booking is for today and not already used,
2. allocates the next token number for that department, for example **MED 047**,
3. shows "You are checked in", the token, "Go to Room 1", and a second QR code that is the patient's **status link**,
4. offers **Print slip**.

Everything the patient needs is on the paper slip: the token, the room, and a link that shows their live position. The kiosk resets after 60 seconds of inactivity ("Still there?"). If the internet drops it shows "Working offline. Tokens are still valid." (the backend reserves a block of numbers per device for exactly this).

"This booking cannot be checked in. Please go to the counter." appears for an unknown or already-used code. A kiosk retry after a timeout never creates a second token (every check-in carries an idempotency key).

### 4.2 The counter

For walk-ins and anyone without a phone. Built for keyboard use: the clerk rarely touches the mouse.

- **Search** by phone number, ABHA number, or name (a name search also needs the district code and year of birth, because names repeat). Results show the household on that phone.
- **Register someone new** (`N`): name, sex, age or year of birth, mobile, relationship to the phone owner, district. If someone similar already exists the clerk sees "Possible duplicates" and chooses "Use this patient" or "This is a different person".
- Select the patient, choose the department, press **Enter**: "Checked in. Token MED 048, Room 1." and a **status link** to write on the slip or send.
- The top bar shows live counts: "Medicine OPD · 12 waiting", updated as tokens move.
- `/` focuses search, `↑ ↓` move through results, `Esc` clears, `?` shows the shortcuts.

Clerks see demographics only, never clinical details. Their patient searches are logged (how many results, not what they typed).

### 4.3 The patient's slip page

The status link (`…/t/<code>`) needs no sign-in and shows only the token, department, room and position. It updates live and plays a chime when called.

| Status | What the patient reads |
|---|---|
| Waiting | the token, "Room 1", "3 people ahead of you", "Expected in 10–15 minutes" |
| Doctor away | "No doctor is in the room right now. Please wait." instead of a misleading time |
| Called | big green screen: "Your turn. Go to Room 1 now" |
| In consultation | "You are with the doctor" |
| Completed | "Visit complete. Collect your medicines from the pharmacy. Keep this slip for your follow-up." |
| Skipped | "You were called 3 times. Go to the help desk to rejoin the queue." |
| Cancelled / session closed | "This visit was cancelled" or "This session has closed. Ask at the help desk about the next session." |
| Transferred | "You were moved to another department. Ask at the help desk." |

The page keeps the last known state if the phone loses signal ("Offline? We'll keep the last update."). When WhatsApp is connected, the same patient also gets messages at 10 people ahead, 3 people ahead, and "Your turn".

### 4.4 The waiting-hall display

A TV, no sign-in, shows only token codes and rooms (no names, ever). Big "Now calling" cards per department (MED 047 → Room 1), a "Next" strip with the next four tokens, "12 waiting", and a chime whenever a token is called. Labels rotate English → Hindi → Gujarati every 8 seconds. The demo display is assigned to Medicine, Paediatrics and Women's OPD; other displays can be assigned other departments. The layout shifts slightly over time to avoid screen burn-in.

---

## 5. The doctor's console

Opens on the doctor's own department queue for today (a dropdown appears if there are several, for example two shifts). The top bar has a status selector: **In OPD**, **On break**, **Off duty**. This matters: patients' expected times are computed from how many doctors are "In OPD" right now, and if none are, patients see "No doctor is in the room right now" instead of a number.

**The queue rail** on the left shows three lanes:

| Lane | Who is in it |
|---|---|
| Urgent | triage level *priority* (for example fever for 5 days, suspected fracture, dog bite, an acute problem in pregnancy, a fall in an elderly person) |
| Protected | age 60 and over, pregnant, or disability, following the usual government-hospital policy |
| General | everyone else |

with the average consultation time and how many doctors are serving.

**Call next** (`N`). The doctor never picks a patient by hand. The server chooses:

1. anyone in the Urgent lane first;
2. otherwise, anyone who has already waited more than 120 minutes, whatever their lane (the "aging guard", so nobody is forgotten);
3. otherwise, Protected and General alternate in a 1 : 2 ratio.

If two doctors share a queue and both press N at once, each gets a different patient.

**The patient card ("Now with you")** shows the token, the complaint in the patient's words, the triage level, and the **pre-brief**:

- **Facts from the record** (always exact, straight from the database): allergies, current medicines, long-term conditions, today's vitals if recorded, risk flags, recent visits.
- **Summary**, written by the AI from a de-identified version of the record: a 1-line headline, a **History** summary of the earlier visits (when, why, diagnosis, medicines), up to 5 key points, up to 3 **Possible conditions to consider** (a differential for the doctor, labelled "AI suggestions for the doctor, not a diagnosis") and up to 3 "Consider asking" questions. "Try again" asks for a new one when the AI was busy. It is labelled **"AI-generated, verify"** and has **Helpful / Not helpful** buttons; the down-votes go to the clinical reviewers weekly. If the AI was unavailable the card says "Summary unavailable. The facts above are complete."
- Anything from documents the patient uploaded is marked **"Patient-provided, unverified"** and never changes the allergy or medicine lists on its own.

The pre-brief is prepared in the background at check-in, patients nearest the front first, so it is ready before the doctor calls them. It is never shown to the patient.

**Actions** (keyboard first):

| Key | Action | What happens |
|---|---|---|
| `S` | Start consult | token becomes *in consultation*; the display moves on |
| `R` | Recall | calls the same token again (display and phone chime again); at most 3 calls in total |
| `K` | Skip | after confirmation; the patient's slip says "go to the help desk". If they come back they rejoin their lane with a 15-minute penalty, not at the back |
| `D` | Diagnosis | free text, saved to the encounter |
| `P` | Prescription | medicine, dose, frequency, days, route; several lines |
| `C` | Complete | after confirmation; the consultation time updates the running average used for everyone's expected wait |
| `?` | Shortcut help | |

If the same patient was changed on another screen (a second doctor, the help desk), the console shows "This patient was updated on another screen. Showing the latest." instead of overwriting.

**End of the session.** When a session closes, anyone still waiting is marked cancelled and, when WhatsApp is connected, offered a priority slot in the next session; anyone called three times who never came back is marked no-show. Both counts go to the daily statistics, because unserved patients are exactly what the hospital needs to see.

---

## 6. Casualty board

`/ed` lists open **pre-alerts** created by emergency outcomes: "45–49 · male", the red flags that fired (for example *chest pain*, *breathless at rest*), the channel (web, WhatsApp, kiosk), minutes ago, and a **Self-harm risk** marker when that applies. The casualty team presses **Acknowledge**; acknowledged alerts move to a short history list. New alerts arrive live with a chime.

---

## 7. The hospital knowledge bot

Choosing **Question about hospital** in the intake (or the API `POST /kb/ask`) answers practical questions in the patient's language:

- OPD timings, which documents are needed for the Ayushman (PM-JAY) card, where the X-ray room is, when reports can be collected, vaccination days, whether medicines are free, where the emergency is, where to get a wheelchair.

How it answers, in order: a curated FAQ (8 topics in the demo, with Hindi and Gujarati variants) → the hospital's own uploaded documents (OPD timings, PM-JAY documents, wayfinding, a self-care leaflet in the demo), from which the AI writes an answer that must cite the passages it used → if nothing matches well enough: "Sorry, I could not find that in the hospital information. Please ask the help desk." It never guesses.

A medical question ("what medicine for fever?") is always redirected: "I cannot give medical advice. A doctor will examine you and decide the treatment. Shall I register you for the OPD?"

---

## 8. After the visit

**On the patient's phone.** As soon as the doctor presses Complete, the slip page shows "Visit complete" and, for the phone that booked the visit, the doctor's diagnosis and every medicine in plain words ("Paracetamol 500 mg: 1 tablet, three times a day, for 3 days, by mouth. After food."), to show at the pharmacy. The hospital page also has **My visits and medicines**: every visit booked from that phone in the last 24 months. The slip link alone never shows medical details; the patient must be signed in with that mobile number.

**On the doctor's screen, next time.** The patient's earlier visits appear in the pre-brief facts, in the AI history summary, and in a **Visit history** list at the bottom: date, department, complaint, triage, diagnosis, medicines, the doctor, and the AI summary written at that visit.

**Follow-up messages.**

Follow-ups are sent over WhatsApp when a number is connected (the demo has none, so they are recorded but not delivered):

- **Day-3 check-in**: "How are you feeling now compared to your visit? Better / Same / Worse". Worse re-runs the danger-sign questions and, if needed, books a priority slot for the next morning.
- **Medicine reminders** (if the patient opts in), **revisit due**, and **report ready** (triggered by staff).

Non-urgent messages respect quiet hours (21:00 to 07:00). "Your turn" and emergency messages ignore them. No marketing messages, ever.

---

## 9. What the AI does, and what it never does

| Task | Done by | If the AI is unavailable |
|---|---|---|
| Spot an emergency in the patient's words | clinician phrase list, before any AI call | unchanged |
| Turn "pet mein jalan 3 din se" into symptom codes | AI (fast model), choosing only from the hospital's catalogue | body-area menu, then symptom list |
| Choose which clarifying question to ask next | AI ranks pre-approved questions | fixed priority order |
| Decide urgency (emergency / priority / routine / self-care) | **rules engine only**; the AI may raise urgency to *priority*, never lower it (enforced in the database) | unchanged |
| Pick the department | rules first (pregnant → Women's OPD, under 14 → Paediatrics…), then the AI suggestion if it is at least 60% confident, else the symptom's default specialty, else Medicine OPD | the same chain without the AI step |
| Everything the patient reads | reviewed templates and leaflets in three languages | unchanged |
| Order of the queue, expected times | arithmetic on the queue | unchanged |
| Pre-brief facts (allergies, medicines, conditions) | copied exactly from the database | unchanged |
| Pre-brief narrative, history summary, possible conditions | AI (smart model) from a de-identified record, for the doctor only; any medicine or allergen it mentions must already be in the record or the line is dropped; possible conditions are labelled as suggestions, not a diagnosis | "Summary unavailable. The facts above are complete." and a Try again button |
| Knowledge-bot answers | AI, limited to quoting the hospital's documents with citations | FAQ only, else "ask the help desk" |

Before any AI call the text is **de-identified**: no name, phone, ABHA number or address; age as a 5-year band; dates relative ("5 months ago"). Every AI call is logged with the prompt version, and each hospital has a daily token budget. The current provider is configured in `backend/.env` (Groq today; Anthropic or any OpenAI-compatible service work the same way).

---

## 10. Privacy and safety rules worth saying out loud

- The app **never diagnoses or prescribes** to a patient. India's Telemedicine Practice Guidelines allow AI only to assist a registered doctor, and the product is built that way.
- **Consent is asked and recorded** (notice version, language, channel) before anything is stored. AI assistance has its own separate consent.
- **No Aadhaar numbers.** ABHA is the only health id, and it is optional.
- **Every look at a patient's record is logged** (who, when, which patient), and the log is written before the data is shown. Patients can ask "who accessed my record".
- **Clerks see demographics only.** Doctors see clinical data only for patients in their care; emergency "break-glass" access exists but is reviewed.
- **Names never appear on the TV or the slip link.** Token codes only.
- **Rules are published with four eyes**: a rule set must pass its own test cases and be approved by a clinical reviewer other than its author before it goes live. Every triage decision records which rule set and which facts produced it, so it can be replayed later.
- **Hospital isolation** is enforced in the database itself: a request without a hospital context returns nothing, not everything.

---

## 11. A five-minute demo script

Have four browser windows ready: a phone-sized one for the patient, the kiosk, the doctor console, and the display. The backend and frontend must be running (`npm run dev` at the project root).

1. **Display** (`/display`, paste the "Main Hall Display" key once). Show the empty board.
2. **Patient** (`/f/GJ-DEMO-DH`). Point out the live department waits. Start a visit, enter any mobile number, use the code shown on screen. Agree to both consents, choose "Someone else", enter a name, sex, age 35. Choose "New health problem" and type: *burning in the stomach for 3 days*. Answer the questions (duration, pain score…). Show the booking: department, reporting window, expected wait, QR.
   - For the emergency path, start another visit and type *chest pain since morning*: the red screen appears and the **Casualty board** (`/ed`) gets a pre-alert.
3. **Kiosk** (`/kiosk`, "Gate Kiosk" key). Scan the booking QR from the phone screen, or type the check-in code. Show the token and the status QR. Open the status link on the phone: "3 people ahead".
4. **Counter** (`/counter`, sign in as the clerk). Register a walk-in, press Enter to check in. Watch the "waiting" count rise on the display.
5. **Doctor** (`/doctor`, sign in as Dr. Mehta with the authenticator code). Show the three lanes. Press `N`: the display and the phone flip to "Your turn, Room 1" with a chime. Show the pre-brief and its "AI-generated, verify" label. `S` to start, `D` for a diagnosis, `P` for a prescription, `C` to complete. The phone shows "Visit complete".

Good questions to invite: "why no token number on the phone?", "why was that person called before me?", "what if the AI is wrong?", all answered in sections 3.4, 5 and 9.

---

## 12. Questions people ask

**Why didn't I get a token number on my phone?** The number is given when you arrive and check in, so nobody can hold a place from home. Arriving inside your reporting window counts as arriving at its start.

**Why was someone who came after me called first?** They were in the Urgent lane (a clinical reason), or in the Protected lane (over 60, pregnant, or disabled) which is served in turn, or they had waited more than two hours. The rule is the same for everyone and the doctor cannot pick favourites.

**I missed my call. Is my token gone?** No. You are called up to three times. After that, the help desk puts you back in your lane with a 15-minute penalty, not at the back.

**Why is the expected time a range?** Because it is an estimate from the average consultation time and the number of doctors present. A single exact time would be a promise the hospital cannot keep.

**Does the app tell me what disease I have or what medicine to take?** No, never. It only decides how urgent the visit is and which department to go to. The doctor decides everything else.

**Did a computer decide I was not an emergency?** The clinician-written rules decided. The AI can only push a case *up* in urgency, never down. And "Book a visit anyway" is always available on the self-care screen.

**Where does my data go?** It stays with this hospital. Anything sent to the AI service has your name, phone and ids stripped out first. Every time staff open your record it is logged, and you can ask for that log.

**What if the internet or the AI service is down?** Tokens can still be issued (kiosks keep a reserved block of numbers), the queue keeps running, the doctor still gets the factual part of the pre-brief, and the intake falls back to menus.

**Can one phone register the whole family?** Yes. The number owns a household; each visit is for one member, and ASHA workers can register villagers from their own phone.

**Why does the doctor need an authenticator app?** Clinical data is sensitive, so doctors, admins and reviewers sign in with a password and a 6-digit code (two-factor).

---

## 13. Things the demo does not show yet

- WhatsApp as a channel (the backend supports it fully; it needs a Meta business number and webhook).
- Admin screens: staff, devices, departments, schedules, rule-set approval, document upload and analytics are available through the API (`/api/v1/docs`) but have no web pages.
- Offline token blocks and uploaded patient documents are implemented in the backend but not exercised by the web screens.
- Ticking follow-ups at "Complete" (the API accepts them; the button sends none).
- Schedules exist only for Monday to Saturday mornings. A booking made after 14:00 IST is placed in an evening session.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| OPD | Out-patient department, the walk-in clinics of a hospital |
| Facility | One hospital; the demo has one, code `GJ-DEMO-DH` |
| Encounter | One visit by one patient; carries the booking, triage, diagnosis, prescription |
| Intake | The question-and-answer conversation before the visit |
| Triage level | emergency / priority / routine / self-care, decided by the rules engine |
| Reporting window | The 30-minute slot in which a remotely booked patient should arrive |
| Check-in | The moment a patient physically arrives (kiosk or counter) and receives a token |
| Token | The queue number, for example MED 047 (prefix per department, number per session) |
| Queue session | One department, one day, one shift; opens with the first check-in, closes at the end |
| Lane | Urgent / Protected / General sub-queues inside a session |
| Slip | The paper or on-screen card with the token and the status link |
| Pre-brief | The doctor's one-screen summary of the patient, prepared before the call |
| Pre-alert | A notice to Casualty that an emergency patient is on the way |
| Knowledge bot | The question-answering assistant for practical hospital questions |
| ABHA | Ayushman Bharat Health Account, India's health id (optional) |
| ASHA worker | Accredited Social Health Activist, a community health worker who may register others |
| Device key | The secret a kiosk or display uses instead of a login |
| Authenticator code / MFA | The 6-digit two-factor code from Google Authenticator or Authy |
| De-identification | Removing names, phones, ids and exact dates before text goes to the AI |
