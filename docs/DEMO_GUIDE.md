# Sahayak demo guide (about 15 minutes)

Sahayak is the front door of a government hospital's OPD, the walk-in clinics. In this demo you play every person involved, one browser tab each: the patient at home, the gate kiosk, the waiting-hall TV, the registration clerk, the doctor and the casualty team.

The same guide, with buttons that open each screen already signed in, is inside the app at **http://localhost:5173/demo**. This file is a copy for reading or sharing.

## Logins

You rarely need these: the purple **Demo** button at the bottom right of every screen signs you in with one click, and in demo mode authenticator codes are filled in for you.

| Who | Screen | Login |
|---|---|---|
| Patient | http://localhost:5173/f/GJ-DEMO-DH | any mobile number, for example 98765 43210; the 6-digit code is shown on screen |
| Gate kiosk | http://localhost:5173/kiosk | no login; click "Use the demo key" |
| Waiting-hall TV | http://localhost:5173/display | no login; click "Use the demo key" |
| Registration clerk | /counter | `clerk@demo.sahayak.health` |
| Doctor, Medicine OPD | /doctor | `dr.mehta@demo.sahayak.health` (+ authenticator code, filled in for you) |
| Staff nurse | /doctor, /ed, /counter | `nurse@demo.sahayak.health` |
| Help desk | /counter | `helpdesk@demo.sahayak.health` |
| Casualty doctor | /ed | `dr.rao@demo.sahayak.health` |
| Hospital administrator | every screen | `admin@demo.sahayak.health` |

The password for every staff account is `Demo@12345678`. Each browser tab keeps its own login, so one tab can be the clerk and another the doctor.

## Before you start

1. Open http://localhost:5173/demo and click **Start a fresh demo**. It clears leftover patients from today's queue, so the doctor only sees yours.
2. Use the buttons there to open: Patient's phone, Gate kiosk, Waiting-hall TV, Counter (clerk), Doctor (Dr. Anil Mehta), Casualty board (nurse).
3. Make the patient's window narrow like a phone, or press F12 and click the phone icon.
4. Put two windows side by side. What one person does appears on the other screen within a second.

## 1. Sunita feels unwell (patient, at home)

Sunita Sharma, 58, has had fever and body ache for two days. Her son books from his phone.

1. Patient tab: **Start a visit**. Mobile **98765 43210**, **Send code**, type the code shown on screen, **Verify**.
2. "Do you agree?" **Yes**. "May we use a computer assistant?" **Yes**.
3. Name **Sunita Sharma**, **Female**, **58**, **My parent**. Then **New health problem**.
4. Type **fever and body ache since 2 days**. Hinglish works too: "2 din se bukhar aur badan dard". The assistant answers **Here is what I understood**: Fever, Body ache, since 2 days.
5. Answer **No** to the danger questions (stiff neck, very high fever, breathless, fainted), **2** days, **None** for long-term illness, **No** for disability.
6. **Your visit is booked**: Medicine OPD, Room 1, a time window to arrive, an expected wait, a QR code. Click **Copy code** under the QR.
7. Scroll to **How Sahayak decided**: what she told us, how urgent and why, which department and how it was chosen, and "This is not a diagnosis".

What happened: her words were first checked for emergency signs. The AI turned them into standard symptom codes, chose the follow-up questions and suggested the department; the hospital's clinical rules, not the AI, decided she is routine. The patient never sees a guessed disease: India's Telemedicine Practice Guidelines let AI assist only the doctor, so the AI's possible diagnoses appear on the doctor's screen (part 4). She has no token number yet: numbers are given only on arrival, so nobody can hold a place from home. The doctor and the TV show nothing for her yet.

## 2. She arrives at the gate (kiosk)

1. Kiosk tab: **Enter the check-in code** (a real kiosk scans the QR), paste, **Check in**.
2. "You are checked in", her token (for example MED-014) and a short slip code under a QR.
3. Patient tab: **Close** under the booking, then under **I already have a slip** type the slip code and **Continue**. This is her live status page. Leave it open.

The doctor's left column now shows her token under General, and her case summary is being prepared in the background.

## 3. A walk-in at the counter (clerk)

Ramesh Patel, 72, has no smartphone.

1. Counter tab: **Register someone new**. Ramesh Patel, Male, age 72, mobile 98765 43211, relationship Self, district 474. **Register** (if it says "Possible duplicates", choose **Use this patient**).
2. Department **Medicine OPD**, **Check in** (or Enter). He gets the next token and a status link.

Ramesh is over 60, so he joins the **Protected** lane. The clerk sees only name, age and phone, never medical details.

## 4. The doctor calls (doctor and TV)

1. Doctor tab: three lanes, Protected (Ramesh) and General (Sunita).
2. **Call next** (N). Ramesh comes first even though Sunita checked in earlier: protected and general patients take turns. The TV shows his token and room with a chime.
3. **Start consult** (S), then **Complete** (C).
4. **Call next** again: Sunita. Her status page turns green, "Your turn, go to Room 1 now", with a chime.
5. Read her card: the facts come from her record; the **Summary** marked "AI-generated, verify" was written by the AI before she walked in: a headline, key points, **Possible conditions to consider** (AI suggestions for the doctor, not a diagnosis) and questions worth asking. The patient never sees it. If it says "Summary unavailable" (the free AI tier is busy), click **Try again**.
6. **Diagnosis** (D) "Viral fever". **Prescription** (P): "Paracetamol 500 mg", dose "1 tablet", frequency TDS, 3 days, advice "After food". **Complete** (C).
7. Sunita's phone now shows "Visit complete" with the diagnosis and "Paracetamol 500 mg: 1 tablet, three times a day, for 3 days, by mouth. After food." She shows it at the pharmacy.

Queue rules in one line: urgent first; protected and general take turns, one protected for every two general; anyone waiting more than two hours goes next. Three missed calls send the patient to the help desk, and they rejoin with a 15-minute penalty, not at the back.

## 5. Sunita comes back (patient and doctor)

1. Open a second patient tab, **Start a visit**, sign in with the same number 98765 43210. It asks "Who is this visit for?": choose **Sunita Sharma** (no name, age or consent questions this time).
2. **New health problem**, type **headache since today**, answer, **Copy code**.
3. Kiosk: **Take your slip**, **Enter the check-in code**, paste, **Check in**.
4. Doctor: **Call next**. The screen now shows her past: the fever visit under Recent visits, paracetamol under Medicines, an AI **History** summary, possible conditions for the headache, and at the bottom the full **Visit history** (24 months). Click a visit to open its diagnosis, medicines, doctor and the AI summary written then.
5. Sunita's phone: the hospital page now has **My visits and medicines**.

## 6. An emergency (patient and casualty)

1. In the second patient tab click **Close**, then **Start a visit**. "Who is this visit for?": **Someone else**, Mahesh Sharma, Male, 61, Spouse.
2. **New health problem**, type **chest pain and sweating since 1 hour**.
3. Red screen: **Go to Casualty now**, call 108. No booking, no more questions.
4. Casualty tab: a new alert with a chime (age group, sex, danger signs). Click **Acknowledge**.

Emergencies never wait in the OPD queue. Danger words are caught by a list written by doctors, before the AI is asked.

## 7. More to try

- **Question about hospital**: "What are the OPD timings?" or "Which documents for Ayushman card?". Answers come only from the hospital's own information; a medical question is refused and a doctor's visit offered.
- Switch the patient screen to **हिंदी** or **ગુજરાતી**. The TV rotates the three languages by itself.
- Answer **No** to the computer assistant: the patient picks body part and symptom from lists instead of typing.

## What each person gets

| Who | Usually | With Sahayak |
|---|---|---|
| Patient | Queues from early morning, no idea how long the wait is | Books from home, arrives in a window, follows the queue on the phone, gets diagnosis and medicines on the phone, in their language |
| Clerk | Writes every patient by hand | Finds people by phone number, registers in seconds, one key to check in |
| Doctor | Starts every patient from zero | Before calling, sees complaint, allergies, medicines, every past visit, an AI summary and possible conditions to consider |
| Casualty | Learns of an emergency when the patient walks in | Alerted the moment danger signs are reported |
| Hospital | Crowded halls, arguments about who came first | Written, fair queue rules on the TV; data on waits and no-shows |

## If something looks stuck

- A screen did not update: reload it (F5).
- The doctor sees someone you did not create: **Start a fresh demo**, then reload the doctor and TV tabs.
- "Too many attempts" on the patient code: use another number (98765 43212, 98765 43213), or wait 10 minutes (3 codes per number every 10 minutes).
- Kiosk or TV asks for a device key: click **Use the demo key**.
- Nothing loads: Docker must be running, and the backend terminal must be running `npm run dev:all` (in `backend/`).

Demo mode only: the Demo button, one-click sign-in and codes printed on screen exist only with a development backend, never in production. For how everything works behind the screens, see [HOW_IT_WORKS.md](HOW_IT_WORKS.md).
