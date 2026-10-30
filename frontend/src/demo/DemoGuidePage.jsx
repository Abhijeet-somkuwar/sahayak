import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Popconfirm } from 'antd';
import { useDemoInfo } from '../hooks/useDemoInfo';
import { InlineNotice } from '../components/ui/Notices';
import { findStaff, formatPhone } from './demoData';
import { useDemoActions } from './useDemoActions';
import './Demo.css';

const Who = ({ kind, children }) => <span className={`who who--${kind}`}>{children}</span>;

function Act({ onClick, disabled, primary, children }) {
  return (
    <Button size="small" type={primary ? 'primary' : 'default'} onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

/**
 * /demo: a guided tour in plain words. You play every person in turn (patient, gate kiosk, clerk, doctor,
 * waiting-hall TV, casualty) and the buttons open each screen, already signed in, in its own tab.
 * The buttons need the development backend; the text works anywhere.
 */
export default function DemoGuidePage() {
  const demo = useDemoInfo();
  const actions = useDemoActions(demo || null);
  const [resetNote, setResetNote] = useState(null);
  const off = !demo;
  const clerk = findStaff(demo, 'clerk@');
  const doctor = findStaff(demo, 'dr.mehta@');
  const nurse = findStaff(demo, 'nurse@');
  const phones = (demo && demo.patient_phones) || ['9876543210', '9876543211', '9876543212'];

  const reset = async () => {
    try {
      const r = await actions.reset();
      setResetNote({ tone: 'success', text: `Done: ${r.cancelled + r.completed} leftover tokens cleared, ${r.prealerts_closed} casualty alerts closed. Reload any screens you already have open.` });
    } catch (e) {
      setResetNote({ tone: 'error', text: `Could not reset: ${e.message}` });
    }
  };

  return (
    <main className="demo-guide">
      <div className="demo-guide__inner">
        <header>
          <p className="demo-guide__kicker">Demo guide · about 15 minutes</p>
          <h1>Try Sahayak as every person in the hospital</h1>
          <p>
            Sahayak is the front door of a government hospital’s OPD (the walk-in clinics). In this guide you play every person involved: a patient at home, the gate
            kiosk, the registration clerk, the doctor, the waiting-hall TV and the casualty team. Keep this page open in one tab. The buttons open each screen in its
            own tab, already signed in.
          </p>
        </header>

        {demo === null && (
          <InlineNotice tone="info">The buttons on this page need the development backend (demo mode). The steps still describe exactly what to click.</InlineNotice>
        )}

        <section className="demo-guide__part">
          <h2>Before you start</h2>
          <ol>
            <li>
              <strong>Clear the queue.</strong> This removes leftover patients from earlier tests, so the doctor only sees the patients you create. Do it again whenever
              you want to start over.
              <div className="demo-guide__actions">
                <Popconfirm title="Start a fresh demo?" description="Clears today's queue and the casualty alerts." okText="Start fresh" onConfirm={reset} disabled={off}>
                  <Button size="small" type="primary" disabled={off}>
                    Start a fresh demo
                  </Button>
                </Popconfirm>
              </div>
              {resetNote && <InlineNotice tone={resetNote.tone}>{resetNote.text}</InlineNotice>}
            </li>
            <li>
              <strong>Open the screens.</strong> Each button opens a new tab. Every tab keeps its own login, so one tab can be the clerk and another the doctor.
              <div className="demo-guide__actions">
                <Act onClick={actions.openPatient} disabled={off}>
                  Patient’s phone
                </Act>
                <Act onClick={() => actions.openScreen('kiosk')} disabled={off}>
                  Gate kiosk
                </Act>
                <Act onClick={() => actions.openScreen('display')} disabled={off}>
                  Waiting-hall TV
                </Act>
                <Act onClick={() => clerk && actions.openStaff(clerk)} disabled={!clerk}>
                  Counter (clerk)
                </Act>
                <Act onClick={() => doctor && actions.openStaff(doctor)} disabled={!doctor}>
                  Doctor (Dr. Anil Mehta)
                </Act>
                <Act onClick={() => nurse && actions.openStaff(nurse, '/ed')} disabled={!nurse}>
                  Casualty board (nurse)
                </Act>
              </div>
            </li>
            <li>
              <strong>Make the patient’s tab look like a phone:</strong> drag that window narrow, or press <kbd>F12</kbd> and click the phone icon at the top of the panel
              that opens.
            </li>
            <li>
              <strong>Put two windows side by side</strong>, for example the patient’s phone next to the TV or the doctor. That is where the product makes sense: what
              one person does shows up on the other screen within a second.
            </li>
          </ol>
          <p className="text-sm text-soft">
            Lost a login? The purple <strong>Demo</strong> button at the bottom right of every screen lists every account, password and device key.
          </p>
        </section>

        <section className="demo-guide__part">
          <h2>
            1. Sunita feels unwell <Who kind="patient">Patient, at home</Who>
          </h2>
          <p className="demo-guide__story">Sunita Sharma, 58, has had fever and body ache for two days. Her son books a hospital visit from his phone.</p>
          <ol>
            <li>
              In the <strong>patient’s phone</strong> tab, click <strong>Start a visit</strong>.
            </li>
            <li>
              Mobile number <strong>{formatPhone(phones[0])}</strong>, then <strong>Send code</strong>. In demo mode the 6-digit code is printed on the screen (no SMS).
              Type it and click <strong>Verify</strong>.
            </li>
            <li>
              “Do you agree?” <strong>Yes</strong>. Then “May we use a computer assistant…?” <strong>Yes</strong>.
            </li>
            <li>
              Name <strong>Sunita Sharma</strong>, <strong>Female</strong>, age <strong>58</strong>, relationship <strong>My parent</strong>.
            </li>
            <li>
              “What do you need today?” <strong>New health problem</strong>.
            </li>
            <li>
              Describe the problem: type <strong>fever and body ache since 2 days</strong>. Hinglish works too, for example “2 din se bukhar aur badan dard”. The
              assistant shows <strong>Here is what I understood</strong>: Fever, Body ache, since 2 days.
            </li>
            <li>
              Answer the few follow-up questions. For this story answer <strong>No</strong> to the danger questions (stiff neck, very high fever, breathless, fainted),{' '}
              <strong>2</strong> for how many days, <strong>None</strong> for long-term illness, <strong>No</strong> for disability. The exact questions can change a
              little, because they are picked for her symptoms.
            </li>
            <li>
              You see <strong>Your visit is booked</strong>: Medicine OPD, Room 1, a half-hour window to arrive, an expected wait and a QR code. Click{' '}
              <strong>Copy code</strong> under the QR.
            </li>
            <li>
              Scroll down to <strong>How Sahayak decided</strong>: what she told us, how urgent it is and why, which department and how it was chosen. It ends with
              “This is not a diagnosis. The doctor will examine you.”
            </li>
          </ol>
          <div className="demo-guide__why">
            <p>
              <strong>What just happened</strong>
            </p>
            <ul>
              <li>Her words were checked for emergency signs before anything else.</li>
              <li>The AI turned “fever and body ache” into standard symptom codes, picked the follow-up questions and suggested the department. The hospital’s clinical rules, not the AI, decided she is a routine case.</li>
              <li>The patient never sees a guessed disease: by law (India’s Telemedicine Practice Guidelines) AI may only assist the doctor. The AI’s possible diagnoses go to the doctor, in part 4.</li>
              <li>She has no token number yet. Numbers are given only on arrival, so nobody can hold a place in the queue from home.</li>
            </ul>
          </div>
          <div className="demo-guide__staff">
            <strong>Look at the staff side:</strong> the doctor and the TV show nothing for her yet, because she has not arrived.
          </div>
        </section>

        <section className="demo-guide__part">
          <h2>
            2. Sunita arrives at the gate <Who kind="screen">Gate kiosk</Who>
          </h2>
          <ol>
            <li>
              In the <strong>kiosk</strong> tab click <strong>Enter the check-in code</strong> (a real kiosk scans the QR with its camera). Paste the code and click{' '}
              <strong>Check in</strong>.
            </li>
            <li>
              The kiosk shows <strong>You are checked in</strong>, her token number (for example <strong>MED-014</strong>; numbers keep counting through the day) and a
              QR code with a short slip code under it. A real kiosk prints this slip.
            </li>
            <li>
              Back in the <strong>patient’s phone</strong> tab, click <strong>Close</strong> under the booking to return to the hospital page. Under{' '}
              <strong>I already have a slip</strong>, type that short slip code and click <strong>Continue</strong>. This is her live status page: people ahead of her
              and the expected wait. Leave it open.
            </li>
          </ol>
          <div className="demo-guide__staff">
            <strong>Look at the staff side:</strong> the doctor’s left column now shows her token under <strong>General</strong>. In the background the system is already
            preparing the doctor’s summary of her case.
          </div>
        </section>

        <section className="demo-guide__part">
          <h2>
            3. A walk-in at the counter <Who kind="staff">Registration clerk</Who>
          </h2>
          <p className="demo-guide__story">Ramesh Patel, 72, has no smartphone. He comes to the registration counter.</p>
          <ol>
            <li>
              In the <strong>counter</strong> tab click <strong>Register someone new</strong>.
            </li>
            <li>
              Full name <strong>Ramesh Patel</strong>, sex <strong>Male</strong>, age <strong>72</strong>, mobile <strong>{formatPhone(phones[1])}</strong>, relationship{' '}
              <strong>Self</strong>, district <strong>474</strong>. Click <strong>Register</strong>. If it says “Possible duplicates”, choose <strong>Use this patient</strong>.
            </li>
            <li>
              Department <strong>Medicine OPD</strong>, then <strong>Check in</strong> (or press <kbd>Enter</kbd>). He gets the next token number and a status link.
            </li>
          </ol>
          <div className="demo-guide__why">
            <p>
              <strong>What to notice:</strong> Ramesh is over 60, so he joins the <strong>Protected</strong> lane (elderly, pregnant or disabled people). The clerk only
              sees name, age and phone, never medical details. Next time, the clerk finds him in seconds by typing his phone number in the search box.
            </p>
          </div>
        </section>

        <section className="demo-guide__part">
          <h2>
            4. The doctor calls patients <Who kind="staff">Doctor</Who> <Who kind="screen">Waiting-hall TV</Who>
          </h2>
          <ol>
            <li>
              In the <strong>doctor</strong> tab, the left column shows three lanes: Urgent, Protected (Ramesh) and General (Sunita).
            </li>
            <li>
              Click <strong>Call next</strong> (or press <kbd>N</kbd>). The system, not the doctor, decides who is next. Ramesh is called first even though Sunita checked
              in earlier: protected and general patients take turns.
            </li>
            <li>
              Look at the <strong>TV</strong> tab: “Now calling”, his token and room, with a chime.
            </li>
            <li>
              In the doctor tab click <strong>Start consult</strong> (<kbd>S</kbd>), then <strong>Complete</strong> (<kbd>C</kbd>) and confirm.
            </li>
            <li>
              Click <strong>Call next</strong> again: now it is Sunita. Watch her <strong>status page</strong> in the patient tab turn green: “Your turn, go to Room 1
              now”, with a chime.
            </li>
            <li>
              Read the middle of the doctor screen. The facts (allergies, medicines, long-term illnesses, past visits) come straight from her record. Below them, the{' '}
              <strong>Summary</strong> marked “AI-generated, verify” was written by the AI before she walked in: a one-line headline, key points,{' '}
              <strong>Possible conditions to consider</strong> (AI suggestions for the doctor, not a diagnosis) and questions worth asking. The patient never sees it. If
              it says “Summary unavailable” (the free AI tier is busy), click <strong>Try again</strong>.
            </li>
            <li>
              Press <kbd>D</kbd> for <strong>Diagnosis</strong>: type “Viral fever”, save. Press <kbd>P</kbd> for <strong>Prescription</strong>: medicine “Paracetamol 500
              mg”, dose “1 tablet”, frequency <strong>TDS</strong> (three times a day), days 3, advice “After food”, save. Press <kbd>C</kbd> to{' '}
              <strong>Complete</strong>.
            </li>
            <li>
              Look at Sunita’s phone: “Visit complete”, and under it the doctor’s diagnosis and her medicines in plain words: “Paracetamol 500 mg: 1 tablet, three times
              a day, for 3 days, by mouth. After food.” She shows this at the pharmacy.
            </li>
          </ol>
          <div className="demo-guide__why">
            <p>
              <strong>The queue rules, in one line:</strong> urgent cases first; then protected and general take turns (one protected for every two general); anyone who has
              waited more than two hours goes next whatever their lane. A patient who misses three calls goes to the help desk and rejoins with a 15-minute penalty, not at
              the back.
            </p>
          </div>
        </section>

        <section className="demo-guide__part">
          <h2>
            5. Sunita comes back <Who kind="patient">Patient</Who> <Who kind="staff">Doctor</Who>
          </h2>
          <p className="demo-guide__story">A few days later Sunita has a headache. This time the doctor sees her history.</p>
          <ol>
            <li>
              Open a second patient tab with the <strong>Patient’s phone</strong> button at the top of this guide (keep her status page open in the first). Click{' '}
              <strong>Start a visit</strong> and sign in with the same number, <strong>{formatPhone(phones[0])}</strong>. This phone has booked before, so it asks{' '}
              <strong>Who is this visit for?</strong> Choose <strong>Sunita Sharma</strong>. No name, age or consent questions this time.
            </li>
            <li>
              <strong>New health problem</strong>, type <strong>headache since today</strong>, answer the questions, then <strong>Copy code</strong>.
            </li>
            <li>
              Kiosk tab: <strong>Take your slip</strong> (back to the start), <strong>Enter the check-in code</strong>, paste, <strong>Check in</strong>.
            </li>
            <li>
              Doctor tab: <strong>Call next</strong>. Now the screen shows her past: <strong>Recent visits</strong> with the fever visit, her paracetamol under{' '}
              <strong>Medicines</strong>, an AI <strong>History</strong> summary (“Earlier: fever and body ache, diagnosed viral fever, given paracetamol…”), possible
              conditions to consider for the headache, and at the bottom the full <strong>Visit history</strong> of the last 24 months. Click a visit to open its
              diagnosis, medicines, doctor and the AI summary written at that visit.
            </li>
            <li>
              Back on Sunita’s phone: the hospital page now has <strong>My visits and medicines</strong>, with every visit booked from this phone.
            </li>
          </ol>
          <div className="demo-guide__why">
            <p>
              <strong>What to notice:</strong> the doctor did not have to ask “have you been here before?”. The facts come from the hospital’s own records; the AI only
              summarises them and suggests what to consider, labelled so the doctor knows to verify.
            </p>
          </div>
        </section>

        <section className="demo-guide__part">
          <h2>
            6. An emergency <Who kind="patient">Patient</Who> <Who kind="emergency">Casualty</Who>
          </h2>
          <ol>
            <li>
              In the second patient tab click <strong>Close</strong>, then <strong>Start a visit</strong>. At <strong>Who is this visit for?</strong> choose{' '}
              <strong>Someone else</strong>: Mahesh Sharma, Male, 61, Spouse.
            </li>
            <li>
              <strong>New health problem</strong>, then type <strong>chest pain and sweating since 1 hour</strong>.
            </li>
            <li>
              The screen turns red: <strong>Go to Casualty now</strong>, with a button to call 108. No more questions and no OPD booking.
            </li>
            <li>
              In the <strong>casualty board</strong> tab a new alert appears with a chime: age group, sex and the danger signs. Click <strong>Acknowledge</strong>.
            </li>
          </ol>
          <div className="demo-guide__why">
            <p>
              <strong>What to notice:</strong> emergencies never wait in the OPD queue. The danger words are caught by a list written by doctors, before the AI is even
              asked, and the casualty team hears about the patient before they arrive.
            </p>
          </div>
        </section>

        <section className="demo-guide__part">
          <h2>
            7. A few more things to try <Who kind="patient">Patient</Who>
          </h2>
          <ul style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li>
              <strong>Ask a question.</strong> In a patient tab that is signed in, start a visit, choose Sunita, then <strong>Question about hospital</strong>, and type “What are the OPD timings?” or “Which
              documents for Ayushman card?”. The answer comes only from the hospital’s own information. A medical question (“which medicine for fever?”) is politely
              refused and a doctor’s visit is offered instead.
            </li>
            <li>
              <strong>Change the language.</strong> On the patient page switch to <strong>हिंदी</strong> or <strong>ગુજરાતી</strong>. The questions and buttons follow,
              and the TV rotates English, Hindi and Gujarati by itself.
            </li>
            <li>
              <strong>Say No to the computer assistant.</strong> The visit still works: instead of typing, the patient picks the body part and the symptom from lists.
            </li>
            <li>
              <strong>Be another staff member.</strong> The Demo button lists every account: the help desk, the casualty doctor, the other departments’ doctors.
            </li>
          </ul>
        </section>

        <section className="demo-guide__part">
          <h2>What each person gets out of it</h2>
          <div className="demo-guide__table">
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Usually</th>
                  <th>With Sahayak</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Patient</td>
                  <td>Queues from early morning for a registration slip, no idea how long the wait is</td>
                  <td>Books from home, arrives in a time window, follows the queue on the phone, gets the diagnosis and medicines on the phone, in their own language</td>
                </tr>
                <tr>
                  <td>Clerk</td>
                  <td>Writes every patient by hand, asks the same family details every visit</td>
                  <td>Finds people by phone number, registers in seconds, one key to check in</td>
                </tr>
                <tr>
                  <td>Doctor</td>
                  <td>Starts every patient from zero</td>
                  <td>Before calling, sees the complaint, allergies, medicines, every past visit, an AI summary and possible conditions to consider; one key per action</td>
                </tr>
                <tr>
                  <td>Casualty team</td>
                  <td>Learns about an emergency when the patient walks in</td>
                  <td>Gets an alert the moment danger signs are reported</td>
                </tr>
                <tr>
                  <td>Hospital</td>
                  <td>Crowded halls, arguments about who came first</td>
                  <td>Fair, written queue rules shown on the TV, and data on waiting times and no-shows</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="demo-guide__part">
          <h2>If something looks stuck</h2>
          <ul style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>A screen did not update: reload it (F5).</li>
            <li>The doctor sees a patient you did not create: click Start a fresh demo above, then reload the doctor and TV tabs.</li>
            <li>“Too many attempts” on the patient code: use another number from the Demo button, or wait 10 minutes (3 codes per number every 10 minutes).</li>
            <li>The kiosk or TV asks for a device key: click “Use the demo key”.</li>
            <li>Nothing loads: check that Docker is running and that the backend terminal shows npm run dev:all running.</li>
          </ul>
          <p className="text-sm text-soft">
            Demo mode only: the Demo button, one-click sign-in and codes printed on screen do not exist in a production installation. More detail:{' '}
            <Link to="/f/GJ-DEMO-DH">the patient app</Link> and docs/HOW_IT_WORKS.md in the project.
          </p>
        </section>
      </div>
    </main>
  );
}
