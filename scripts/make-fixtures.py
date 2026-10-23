#!/usr/bin/env python3
"""
Regenerate the offline fixtures.

These exist for three reasons:
  1. the sandbox/CI has no internet, so the pipeline must be testable offline;
  2. the two accuracy tiers need a reproducible example of each;
  3. the thermodynamics fixture has hand-labelled ground-truth topic starts,
     which is what scripts/evaluate.js measures the detector against.

Run: python3 scripts/make-fixtures.py
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
FIXTURES.mkdir(exist_ok=True)


def json3(events):
    """Build a YouTube json3 caption payload from (start_seconds, duration, text) rows."""
    out = []
    for start, dur, text in events:
        out.append(
            {
                "tStartMs": int(start * 1000),
                "dDurationMs": int(dur * 1000),
                "segs": [{"utf8": text}],
            }
        )
    return {"wireMagic": "pb3", "events": out}


def stamp(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


# ---------------------------------------------------------------- #
# 1. Verified example: creator wrote chapters in the description.
# ---------------------------------------------------------------- #

verified_chapters = [
    (0, "Introduction to Circular Motion"),
    (95, "Angular Displacement and Angular Velocity"),
    (258, "Relation Between Linear and Angular Speed"),
    (430, "Centripetal Acceleration Derivation"),
    (612, "Why the Direction of Velocity Changes"),
    (780, "Solved Problem 1: Car on a Circular Track"),
    (955, "Banking of Roads and the Optimum Speed"),
    (1140, "Solved Problem 2: Banking with Friction"),
    (1320, "Vertical Circular Motion and Minimum Speed"),
    (1500, "Summary and Revision Checklist"),
]

description_chapters = "\n".join(f"{stamp(s)} {label}" for s, label in verified_chapters)

verified = {
    "id": "fixtureVer1",
    "meta": {
        "title": "Circular Motion — Complete One Shot for JEE Main",
        "channel": "Physics Wallah Foundation",
        "lengthSeconds": 1625,
        "description": (
            "Circular Motion complete revision for JEE Main 2026.\n\n"
            "Topics covered:\n"
            f"{description_chapters}\n\n"
            "Notes PDF: https://example.com/notes/circular-motion.pdf\n"
            "Join the Telegram group for doubts: https://example.com/telegram\n"
        ),
    },
    "chapters": [{"startMs": s * 1000, "label": label} for s, label in verified_chapters],
    "captionTrack": {"languageCode": "en", "name": "English", "kind": "asr"},
    "captionsJson3": json3(
        [
            (0, 6, "in this lecture we are going to complete circular motion"),
            (7, 5, "first let us understand angular displacement"),
            (96, 6, "so angular displacement is the angle through which"),
            (300, 5, "the relation between v and omega is v equals r omega"),
            (431, 6, "now let us derive the centripetal acceleration"),
            (613, 5, "and here you can see the velocity direction changes"),
            (781, 6, "let us solve the first problem of a car on a circular track"),
            (956, 5, "moving on to banking of roads"),
            (1141, 6, "next question is banking with friction"),
            (1321, 5, "now vertical circular motion and the minimum speed"),
            (1501, 5, "finally the summary and revision checklist"),
        ]
    ),
}

# ---------------------------------------------------------------- #
# 2. Inferred example: no chapters at all, but a transcript full of
#    transitions. Ground truth is hand-labelled from the transcript.
# ---------------------------------------------------------------- #

# (start_seconds, text) — ASR-shaped lines, some deliberately mid-sentence so the
# "was the cue at a sentence start?" rule is exercised.
thermo_lines = [
    (0, "ok so in today's lecture we will finish the second law of thermodynamics"),
    (6, "we will start with the basics and slowly move to the carnot cycle"),
    (13, "before that a quick recap of the first law"),
    (20, "the first law is just energy conservation for a gas"),
    (30, "so now let's move on to the second law of thermodynamics"),
    (38, "the second law tells us the direction of heat flow"),
    (46, "heat always flows from a hotter body to a colder body"),
    (55, "kelvin planck and clausius statements are the two versions"),
    (66, "as we discussed earlier when we looked at heat engines this matters a lot"),
    (75, "next topic is entropy"),
    (83, "entropy is a measure of the disorder of the system"),
    (92, "the change in entropy is the integral of dq over t"),
    (104, "for a reversible process this is exact"),
    (112, "now let's look at heat engines"),
    (120, "a heat engine takes heat from a hot reservoir"),
    (130, "and converts part of it into work"),
    (139, "the efficiency is one minus q two by q one"),
    (150, "no engine can be one hundred percent efficient"),
    (160, "let's now discuss the carnot cycle"),
    (169, "the carnot cycle has four reversible processes"),
    (178, "two isothermal and two adiabatic"),
    (188, "the efficiency depends only on the two temperatures"),
    (199, "next we come to refrigerators and heat pumps"),
    (209, "a refrigerator is the reverse of a heat engine"),
    (220, "the coefficient of performance is the useful effect by the work input"),
    (233, "moving on to the solved examples now"),
    (243, "first question is a carnot engine operating between two temperatures"),
    (256, "we will find the efficiency from the temperatures directly"),
    (268, "second question is about entropy change in mixing"),
    (281, "you have to integrate carefully here"),
    (294, "finally let's do a quick revision"),
    (303, "remember entropy always increases for an irreversible process"),
    (313, "and the carnot efficiency is the maximum possible"),
]

thermo_truth = [
    (0, "Introduction"),
    (30, "Second Law of Thermodynamics"),
    (75, "Entropy"),
    (112, "Heat Engines"),
    (160, "Carnot Cycle"),
    (199, "Refrigerators and Heat Pumps"),
    (233, "Solved Examples"),
    (294, "Quick Revision"),
]

# Convert to json3 with sentence-ish durations; keep the phrasing intact.
thermo_events = [(t, 6, text) for t, text in thermo_lines]

inferred = {
    "id": "fixtureInf1",
    "meta": {
        "title": "Second Law of Thermodynamics — Full Lecture",
        "channel": "Physics Galaxy",
        "lengthSeconds": 322,
        "description": (
            "Complete lecture on the second law of thermodynamics, entropy and the carnot cycle.\n\n"
            "Join the course: https://example.com/course\ntelegram: https://example.com/telegram\n"
        ),
    },
    "chapters": [],
    "captionTrack": {"languageCode": "en", "name": "English (auto-generated)", "kind": "asr"},
    "captionsJson3": json3(thermo_events),
    "groundTruth": [{"startMs": s * 1000, "label": label} for s, label in thermo_truth],
    "transcript": [{"startMs": t * 1000, "text": text} for t, text in thermo_lines],
}

(FIXTURES / "verified-example.json").write_text(json.dumps(verified, indent=2) + "\n")
(FIXTURES / "inferred-example.json").write_text(json.dumps(inferred, indent=2) + "\n")

print("wrote", FIXTURES / "verified-example.json")
print("wrote", FIXTURES / "inferred-example.json")
print(f"verified: {len(verified['chapters'])} chapters, {len(verified['captionsJson3']['events'])} cues")
print(f"inferred: {len(thermo_events)} cues, {len(thermo_truth)} ground-truth topics")
