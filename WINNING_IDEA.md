# Hack for Humanity | Summer 2026: Winning Idea Dossier

> **Status:** Idea selected; no product name assigned; no implementation started.
> **Submission deadline:** September 4, 2026 at 8:45 PM PT.
> **Ground truth:** [HACKATHON.md](./HACKATHON.md) remains authoritative for rules, form fields, eligibility, and links.

## Final decision

A webcam-based cervical joint-position-error test that measures eyes-closed head repositioning, trains it, and distinguishes real improvement from measurement noise.

## Why this document exists

This is the recovered and finalized output of the Claude Opus 5 Max brainstorming session, including its ruthless elimination, rubric scoring, adversarial review, committed scope, technical architecture, early kill test, build order, demo plan, and honest failure modes. Descriptive phrases below are concept labels only, not a project name.

## Pass 1 — Kill

1. Convergence-break meter — Out of scope, physically. Normal NPC break is 5–10 cm. Laptop webcams and phone front cameras have a minimum focus distance of roughly 20–25 cm and a field of view that loses both eyes well before that. The measurement range sits inside the blind spot of the only sensor you have. Not a difficulty; a wall.

2. Screen-flash pupillometry — Out of scope, physically. A visible-light camera cannot image a dark-adapted pupil, because in the dark there is no light to image it with. Kill the dark adaptation and you kill the constriction amplitude, and what's left is fought by webcam auto-gain. Two independent hardware blocks, neither fixable in software.

3. Instrumented sway — survives to Pass 2, but note the drag: Sway Medical is a real, FDA-cleared product doing precisely this, and it's the highest-typicality item on the list. Verify that in ten minutes on day one.

4. Effort-validity detector — Rubric miss + unvalidatable. Scores near zero on "Domain Effectiveness," which asks how well-being improves; catching a malingerer improves nobody's well-being on the four-minute timescale a judge cares about. And the central claim cannot be validated at n=20, so "how do you know it works?" has no answer but a demo of you personally faking it once.

5. Screen-tolerance probe — Undemoable. You are not concussed. The winning artifact is a rising fatigue curve that a healthy builder does not produce. You would be filming a flat line and narrating what it would look like on somebody else.

6. Content-blind keystroke timing — Undemoable + rubric miss. Integers changing on a screen is not a moment, and the whole thing lives in one criterion (Data Safety) while scoring near zero on Clinical Effectiveness and Neuroscience Understanding. Judges penalise exactly this shape.

7. Dual-task gait cost — survives to Pass 2.

8. Rehab dose verification — survives to Pass 2.

9. Interoceptive calibration — Fake difficulty inverted: real difficulty you cannot reach. The heartbeat-discrimination task requires beat-synchronous tone delivery in real time, and rPPG needs a multi-second filter buffer to produce a beat at all. You cannot play a tone synchronous with a beat you will not detect for four seconds. Separately, RSA needs beat timing to ~10–20 ms and webcam rPPG delivers 30–50 ms. Two fatal precision requirements, either one sufficient.

10. MDC engine — Not a product. It has no surface, no elevator pitch, and nothing to film. Killed as a standalone, absorbed as a component of whatever wins. That is its correct role and it is a valuable one.

11. Head repositioning accuracy — survives to Pass 2.

12. Revealed effort cost — Undemoable. The winning frame requires a person whose stated and revealed preferences diverge. You cannot guarantee you have one on camera, and with no normative sample the fitted curve is a shape with no referent. An 8-minute task also loses every judge who clicks the live link.

Six dead. One absorbed. Four survive.

The lens that did most of the killing: you are not concussed. Any assessment idea whose demo requires real impairment is undemoable by a solo builder. What survives is what you can perturb, train, or verify on a healthy person in front of a camera.

## Pass 2 — Score the survivors

Ten criteria, taken verbatim from the four rubrics, duplicates merged. Out of 100.

#3 Instrumented sway — 59

Domain Effectiveness 5 — measures, changes nothing; there is no intervention in it.
Feasibility & Safety 7 — no hardware, but you are asking a concussed person to stand on one leg unsupervised.
Technical Complexity 6 — competent DSP with no fitted model; "Best Use of AI/ML" will not recognise it.
Data Safety & Responsibility 5 — accelerometer data, no distinctive privacy claim, no model to be responsible about.
Innovation & Novelty 3 — a commercial product does this, and your competitors will guess it too.
UI/UX & Accessibility 6 — excludes anyone with a mobility limitation, which in a well-being hackathon is noticed.
Clinical & Domain Effectiveness 7 — mBESS sits inside the SCAT; instrumenting it is defensible.
Safety & Responsible Design 6 — fixable with a spotter warning and an MDC band.
Neuroscience Understanding 6 — the sensory-integration story is real but you'll deliver it in one sentence.
Research Foundation 8 — strong, citable literature.

#7 Dual-task gait cost — 61

Domain Effectiveness 5 — assessment only.
Feasibility & Safety 6 — you are instructing someone with a head injury to walk while deliberately distracted.
Technical Complexity 7 — step-event detection with pocket-harmonic rejection is genuinely hard DSP; still no fitted model.
Data Safety & Responsibility 5 — nothing distinctive to say.
Innovation & Novelty 6 — rare in hackathons, ordinary in the research literature.
UI/UX & Accessibility 4 — needs 30 m of clear corridor, excludes mobility-limited users, and films badly when you are holding the camera yourself.
Clinical & Domain Effectiveness 8 — "deficits outlast symptom resolution" is the best single clinical argument available to you.
Safety & Responsible Design 5 — see above.
Neuroscience Understanding 7 — attentional resource allocation is a clean story.
Research Foundation 8 — solid.

#8 Rehab dose verification — 65

Domain Effectiveness 8 — the only survivor that touches treatment rather than assessment.
Feasibility & Safety 5 — VOR exercises are symptom-provoking by design and you cannot prescribe a dose.
Technical Complexity 7 — differentiation, smoothing, and a real motion-blur problem.
Data Safety & Responsibility 6 — on-device video is a decent story.
Innovation & Novelty 7 — dose fidelity is genuinely under-served.
UI/UX & Accessibility 6 — webcam plus vigorous head movement.
Clinical & Domain Effectiveness 8 — closest to actual therapy.
Safety & Responsible Design 4 — this is the weak one. An unsupervised tool whose feedback loop pushes a head-injured person to move their head faster is the only idea here that can hurt someone. That criterion is explicitly on the sheet and a clinician judge will find it in fifteen seconds.
Neuroscience Understanding 7 — VOR adaptation is excellent material.
Research Foundation 7 — VRT literature is solid.

#11 Head repositioning accuracy, with #10 absorbed — 84

Domain Effectiveness 8 — measure blind, train with feedback, measure blind again; a number moves inside one session.
Feasibility & Safety 9 — seated, eyes closed, small slow movements. No fall risk, no symptom provocation. The safest thing on the list by a distance.
Technical Complexity 8 — differential Procrustes pose on a rigid landmark subset, jitter-derived endpoint estimation, SEM→MDC with a practice-effect model.
Data Safety & Responsibility 8 — landmarks only, on-device, zero network, and you publish your own error floor unprompted.
Innovation & Novelty 9 — nothing in this space looks like it.
UI/UX & Accessibility 8 — 90 seconds, no reading, audio-cued. The test is performed with eyes closed, which forces a non-visual interface, which is the accessibility story rather than a bolt-on.
Clinical & Domain Effectiveness 8 — published threshold, published training protocol, both citable.
Safety & Responsible Design 9 — the MDC refusal is the design; the tool declines to report changes smaller than its own noise.
Neuroscience Understanding 9 — cervical mechanoreceptor afferents into the vestibular nuclei is a deep, mechanistic, non-obvious story that maps directly onto that criterion.
Research Foundation 8 — real literature, though thinner in the concussion population specifically than in whiplash.

The gap is not close and it is not rigged. #11 wins because it is the only survivor that both measures and treats, and the only one where safety is a strength rather than a liability.

## Pass 3 — Adversarial review
### Against #11

"This is a party trick. I get 3 degrees. Is that good? You don't know."
Partly conceded. The commonly cited abnormal cutoff in the neck-pain literature is around 4.5°, and you will cite it — but with a reference sample of eight people you cannot diagnose anyone, and if you imply otherwise a clinician judge will end you. The defensible frame is within-subject: this is a change detector with a stated noise floor, and the population threshold is a reference line drawn on the chart, not a verdict. Say that out loud in the video before the judge thinks it.

"Your training effect is a practice effect. You built an app that measures how good people get at using your app."
Largely conceded, and this is the sharpest objection. Single-session improvement in a repositioning task is partly genuine sensorimotor recalibration and partly familiarity, and you cannot separate them with n=1. What you can defend: the tool detects change larger than its own measurement error, and it says so explicitly rather than reporting every wobble as recovery. Do not claim you cured anything. Claim you measured something with a known error bar, which is more than every other submission in the track will do.

"MediaPipe gives you head pose. You imported a library and drew an arc."
This is the real hit and it must be answered in the build, not the pitch. The naive version — call the library, read the pose — has a person-specific systematic error of several degrees against a threshold of 4.5°, and is worthless. The work is everything after the library: personalised reference geometry, rigid-subset selection, Procrustes alignment, endpoint averaging against a session-measured jitter threshold, and error characterisation against an independent ground truth. If you cannot show that on screen, the objection stands and you deserve it.

"Cervical proprioception is a neck problem. This is a brain injury track."
Answerable, and answering it well is worth more than the objection costs. The mechanism that concusses a brain also whips a neck; cervical afferents are a major input to the vestibular nuclei, and cervicogenic contribution to post-concussion dizziness is recognised in the rehab literature. Most tools in that track will measure the ear and the brain and ignore the third input entirely. That is your entire "Neuroscience Understanding" score. It belongs in the first twenty seconds of the video.

### Against #8

"You are telling a kid with a head injury to shake their head faster, unsupervised, and colouring a bar green when they comply. Who prescribed this?"
Conceded. Fully. There is no version of this that a solo builder ships in 26 days with a defensible safety story, because the entire premise is dose escalation without a clinician. "Safety & Responsible Design" is an explicit criterion and this fails it structurally, not cosmetically.

"At therapeutic velocity your tracker is looking at motion blur."
Half-answerable, and the answer costs you the demo. The gyro fallback works and looks like a person holding a phone against their head. Choosing it trades your only visual asset for correctness.

Second place, and it isn't second by a little.

## Pass 4 — Commit

#11. Head repositioning accuracy, with the MDC layer built in from day one.

## The one-line version

A 90-second webcam test that measures how accurately you can find your own head's neutral position with your eyes closed, trains it, re-measures — and tells you whether the improvement was real or just noise.

## The specific problem

People with post-concussion or whiplash dizziness. The neck is dense with mechanoreceptors feeding the vestibular nuclei; when that input is disrupted, the person is dizzy and unsteady for cervical reasons, gets assessed vestibularly, and receives vestibular rehab that does not address the input that is actually broken. Joint position error is the standard measure of that input. Today it is assessed with a laser headlamp and a paper target at 90 cm, in clinic, occasionally — which means the parameter is measured perhaps twice in an entire recovery, and never on the days it changes. Between visits, nobody knows whether the neck work is doing anything.

Verify the epidemiology and the 4.5° cutoff yourself before either goes on screen. Ten minutes, day one. If the number you find differs, use the one you found and cite it.

## Scope boundary

The one thing: measure joint position error to neutral, train it with real-time feedback, re-measure, and report the change against the measured minimal detectable change.

Explicitly not building:

Any second test. No balance, no reaction time, no symptom checklist, no battery. The moment you add a second measure you own two noise floors and finish neither.
Accounts, cloud sync, clinician portal, sharing. Sessions live in the browser. This is also your privacy story, so the cut is free.
Any recommendation. No return-to-play, no return-to-learn, no "you are cleared," no traffic lights. You output a number, an interval, and a verdict about whether the number moved. Nothing else.
## Architecture

Single page, deployed on Render (you have the credits and Best Use of Render is a listed prize).

getUserMedia → FaceLandmarker (WASM, on-device)
    → rigid-subset landmark cloud, per frame
    → [CALIBRATION] robust average over 5s neutral hold → reference cloud R₀
    → [PER FRAME] Procrustes align current cloud → R₀ → rotation matrix → yaw/pitch/roll
    → [STATE MACHINE] neutral hold → rotate cue → return → stationarity detect → endpoint window
    → [METRIC] constant error, absolute error, variable error, per direction
    → [RELIABILITY] session jitter → SEM → MDC95
    → render; nothing leaves the tab

The hard part lives in two boxes: the Procrustes alignment against a personalised reference, and the stationarity-detection-plus-endpoint-averaging that buys the precision down under the clinical threshold.

## The hard technical core

1. Differential pose, never absolute pose. Generic-model PnP carries person-specific systematic bias of several degrees — fatal against a 4.5° threshold. But you never need absolute pose; you need the angle between two poses of the same face, seconds apart, under the same lighting, where systematic bias cancels. So: build the reference cloud from the person's own neutral hold, then per frame solve the rotation aligning current landmarks to that reference (Kabsch/Procrustes, translation removed first). Landmark subset selection is load-bearing: use nose bridge, orbital rims, temples, upper forehead. Exclude mouth, jaw, brows, eyelids — they move with expression and blinking, and a blink injecting half a degree of phantom rotation at the endpoint is exactly the failure that makes your instrument useless.

2. The endpoint estimator is where you buy precision. The subject returns and stops; you must detect "stopped" without a fixed velocity threshold, because a fixed threshold either fires on tracker jitter or never fires. Measure the session's own angular jitter during the neutral hold, derive the stationarity threshold from it, then average the rotation over the stationary window. Averaging N frames reduces jitter by √N — 30 frames of a one-second hold turns 2° of per-frame noise into roughly 0.4°. That arithmetic is the entire reason this project is possible, and it is the thing to say in the video.

3. Change versus noise. Run repeated pre-trials, compute SEM from the intraclass correlation, MDC95 = 1.96 × √2 × SEM. Any pre/post difference inside that band is reported as no change, in those words. Report constant, absolute, and variable error separately — that decomposition is standard in the JPE literature and using it correctly is a domain-knowledge signal a clinician judge reads instantly.

4. Characterise your own error against independent ground truth. Strap a phone to your head with a beanie or headband. Record gyroscope while the webcam pipeline runs. Segment both streams into trials independently and match them in order — you need no clock sync, because you are comparing per-trial endpoint angles, not waveforms. Gyro drift over a three-second trial is negligible. This gives you a real RMS error figure for your own instrument, obtained with hardware you already own, in one evening.

## Build order
Days 1–2 — the gyro validation harness. Before any UI. This is go/no-go.
Days 3–5 — ugly end-to-end. Camera → calibration → one trial → a number on screen, deployed and reachable by URL. Working path exists by day five; everything after is improvement.
Days 6–8 — trial state machine. Six trials per direction, stationarity detection, the three-error decomposition.
Days 9–11 — reliability layer. Instrument-check screen, SEM, MDC95, the refusal logic.
Days 12–14 — training mode. Real-time head-position cursor to a target, no numbers shown during training.
Days 15–16 — pre/post protocol wired end to end. The number that moves now exists.
Days 17–19 — UI and accessibility. Audio cueing is not decoration; the test is performed with eyes shut. Large type, high contrast, keyboard-operable, screen-reader labels. Budget all three days. This is the criterion an engineer's build always loses.
Days 20–21 — collect repeatability on 6–8 people. Publish your own error table in the README and on screen.
Days 22–24 — video. Script it before you shoot it.
Days 25–26 — Devpost writeup, screenshots, README, buffer.

Submit valid early — the first 200 submissions get the domain, and a submitted-then-updated entry beats a perfect one at 8:46 PM.

## Riskiest assumption

That webcam differential head rotation resolves to well under the clinical threshold — specifically, endpoint-averaged trial error of ≤1° RMS.

The 48-hour experiment: headband, phone, gyro logging, 20 rotate-and-return trials, compare per-trial endpoint error from webcam against gyro. Two hours of work.

Under 1° RMS: build it, and that comparison plot goes straight into the video.
1–1.5°: build it, and state the error floor everywhere the number appears.
Over 1.5°: stop. The instrument cannot resolve the thing it exists to measure. Fall back to #3, which is safe and mediocre, and accept a mediocre finish over a confident wrong one.
## The demo
0:00–0:20 — Face to camera. The neck is a sensory organ feeding the vestibular system; when it's damaged, people are dizzy for reasons nobody is measuring. Land the brain-injury relevance here, not later.
0:20–0:35 — How it's measured today: laser headlamp, target at 90 cm, clinic only, twice per recovery.
0:35–1:05 — Live baseline. Eyes closed, audio cue, rotate, return. Eyes open — arc appears, error in degrees, threshold line marked.
1:05–1:35 — The credibility shot. Split screen: webcam-derived angle over gyro ground truth, RMS error stated out loud. Nobody else in this hackathon will validate their own instrument.
1:35–2:15 — Training mode, compressed. Cursor to target, real-time.
2:15–2:45 — ★ WINNING MOMENT, 2:30 ★ Blind re-test. Error drops. The app prints the change and the verdict: change 2.8°, MDC95 1.6°, real. Then immediately show a second run where the drop is 1.1° and the app says: inside your noise band — not a change. A tool refusing to give you the answer you want is the most memorable four seconds available to you in this hackathon.
2:45–3:05 — Network tab open, zero requests, during a live test. Five seconds, unfakeable-looking.
3:05–3:40 — How it was built: personalised reference geometry, rigid landmark subset, √N endpoint averaging, SEM to MDC.
3:40–4:00 — Limits, plainly: not a diagnosis, within-subject only, error floor is X°, n=8 reference sample.
## Rubric map
Domain Effectiveness — measures, trains, re-measures; the outcome variable changes within the session.
Feasibility & Safety — seated, eyes closed, slow small movements, no provocation, no fall risk, no hardware.
Technical Complexity — differential Procrustes on a personalised reference, jitter-derived stationarity, reliability modelling. None of it is a library call.
Data Safety & Responsibility — landmarks only, on-device, zero network, demonstrated live; own error rate published unprompted.
Innovation & Novelty — a validated clinical measure that currently requires a laser headlamp, performed on a laptop.
UI/UX & Accessibility — audio-first because the eyes are shut; 90 seconds; no reading required.
Clinical & Domain Effectiveness — published measure, published threshold, published training protocol, all cited.
Safety & Responsible Design — the tool declines to report changes smaller than its own measurement error, and says so on screen.
Neuroscience Understanding — cervical afferents into the vestibular nuclei, and why the third input to balance goes unmeasured.
Research Foundation — cite the JPE literature, the whiplash overlap, and your own reference sample with its n stated.
## What would make this lose anyway

The gyro check comes back at 2–3° and you build it anyway because you've already committed emotionally. That is the failure mode, and it happens on day two.

Beyond that: you are not the favourite for Responsible AI. Fitting statistical models is not what those judges will see rewarded next to a trained network, and $8,676 will attract people with networks. Your realistic targets are Concussion Recovery, Innovation & Creativity, and Design — pursue those and treat the AI/ML track as a free extra checkbox rather than a design constraint.

Then: a judge who does not buy the cervicogenic argument reads this as a neck app in a brain track and moves on at second fifteen. Public Voting is a popularity contest and this has no mass hook. And the UI is where a clinician-engineer always bleeds — if you take days back from the design block to add a feature, you will lose on the criterion that appears in every single rubric.

Last one, and it is the one that matters outside the hackathon: someone with a real injury runs it, gets a reassuring number, and delays care. Write the copy that prevents that before you write the copy that sells it.
