"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Per-mode wording. Hitting and Pitching share one layout on purpose.
const MODES = {
  hitting: {
    sub: "Upload a swing clip (open-side view) and get a Load / Unload read.",
    button: "Analyze Swing",
    loading: "Analyzing your swing. This usually takes 1 to 3 minutes. Please keep this page open.",
  },
  pitching: {
    sub: "Upload a delivery (open side or behind, or both) and get a Load/Balance and Separation read.",
    button: "Analyze Pitching",
    loading: "Analyzing your pitch. This usually takes 1 to 3 minutes. Please keep this page open.",
  },
};

// Shown instead of the mode's loading message once an analysis passes this
// many seconds, so a long wait doesn't look frozen.
const SLOW_AFTER_SECONDS = 120;
const SLOW_MESSAGE = "Still working. Longer videos can take up to 3 minutes. Please keep this page open.";

function formatElapsed(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const ANGLE_NAMES = { open: "open side", behind: "behind" };

// One drag-and-drop / tap-to-choose box. Click and drop both call onChoose.
function FilePicker({ id, file, onChoose, prompt }) {
  const [dragging, setDragging] = useState(false);

  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <>
      <label
        className={`file${dragging ? " dragover" : ""}`}
        htmlFor={id}
        onDragEnter={(e) => {
          stop(e);
          setDragging(true);
        }}
        onDragOver={(e) => {
          stop(e);
          setDragging(true);
        }}
        onDragLeave={(e) => {
          stop(e);
          setDragging(false);
        }}
        onDrop={(e) => {
          stop(e);
          setDragging(false);
          onChoose(e.dataTransfer?.files?.[0]);
        }}
      >
        <strong>{prompt}</strong>
        <br />
        or drag one here — clips under 30 MB
        <input
          id={id}
          type="file"
          accept="video/*"
          onChange={(e) => onChoose(e.target.files?.[0])}
        />
      </label>
      {file && <div className="filename">{file.name}</div>}
    </>
  );
}

export default function AnalyzerPage() {
  const [sport, setSport] = useState("hitting");
  const [angle, setAngle] = useState("open"); // angle of the first pitching clip
  const [file1, setFile1] = useState(null);
  const [file2, setFile2] = useState(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds since Analyze was pressed
  const [error, setError] = useState("");
  const [report, setReport] = useState("");

  // Running timer while an analysis is in progress.
  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [loading]);

  const mode = MODES[sport];
  const otherAngle = angle === "open" ? "behind" : "open";

  // Guard the whole document so a near-miss drop doesn't open/download the file.
  useEffect(() => {
    const prevent = (e) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Single source of truth: click and drop both land here.
  function chooseFile(setter, file) {
    if (!file) return;
    if (file.type && !file.type.startsWith("video/")) {
      setError("That doesn't look like a video file.");
      return;
    }
    setError("");
    setReport("");
    setter(file);
  }

  function changeSport(next) {
    if (next === sport || loading) return;
    setSport(next);
    setFile2(null); // only pitching uses a second clip
    if (next === "hitting") setAngle("open"); // hitting is always open side
    setError("");
    setReport("");
  }

  async function analyze() {
    if (!file1) return;
    setLoading(true);
    setError("");
    setReport("");
    try {
      const form = new FormData();
      form.append("sport", sport);
      form.append("video", file1);
      form.append("angle", sport === "hitting" ? "open" : angle);
      if (sport === "pitching" && file2) {
        form.append("video2", file2);
        form.append("angle2", otherAngle);
      }
      const res = await fetch("/api/swing-analyzer/analyze", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed.");
      setReport(data.report);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>{"Swing & Pitching Analyzer"}</h1>
        <div className="sub">{mode.sub}</div>
      </div>

      <div className="card">
        <div className="field-label">Mode</div>
        <div className="sport-toggle">
          <button
            type="button"
            className={`sport-btn${sport === "hitting" ? " active" : ""}`}
            aria-pressed={sport === "hitting"}
            disabled={loading}
            onClick={() => changeSport("hitting")}
          >
            Hitting
          </button>
          <button
            type="button"
            className={`sport-btn${sport === "pitching" ? " active" : ""}`}
            aria-pressed={sport === "pitching"}
            disabled={loading}
            onClick={() => changeSport("pitching")}
          >
            Pitching
          </button>
        </div>

        {sport === "pitching" && (
          <>
            <div className="field-label">Camera angle of your first clip</div>
            <div className="sport-toggle">
              <button
                type="button"
                className={`sport-btn${angle === "open" ? " active" : ""}`}
                aria-pressed={angle === "open"}
                disabled={loading}
                onClick={() => setAngle("open")}
              >
                Open side
              </button>
              <button
                type="button"
                className={`sport-btn${angle === "behind" ? " active" : ""}`}
                aria-pressed={angle === "behind"}
                disabled={loading}
                onClick={() => setAngle("behind")}
              >
                Behind
              </button>
            </div>
          </>
        )}

        <FilePicker
          id="video"
          file={file1}
          onChoose={(f) => chooseFile(setFile1, f)}
          prompt={
            sport === "pitching"
              ? `Tap to choose your ${ANGLE_NAMES[angle]} clip`
              : "Tap to choose a video"
          }
        />

        {sport === "pitching" && (
          <>
            <div className="field-label">Optional second clip</div>
            <div className="hint">
              Add the {ANGLE_NAMES[otherAngle]} view too for a fuller read.
            </div>
            <FilePicker
              id="video2"
              file={file2}
              onChoose={(f) => chooseFile(setFile2, f)}
              prompt={`Tap to add your ${ANGLE_NAMES[otherAngle]} clip`}
            />
          </>
        )}

        <button
          className="primary"
          disabled={!file1 || loading}
          onClick={analyze}
        >
          {loading ? "Analyzing…" : mode.button}
        </button>

        {loading && (
          <div className="status">
            <span className="spinner" />
            {elapsed >= SLOW_AFTER_SECONDS ? SLOW_MESSAGE : mode.loading}{" "}
            <span className="elapsed">{formatElapsed(elapsed)}</span>
          </div>
        )}
        {error && !loading && <div className="status error">{error}</div>}
      </div>

      {report && (
        <div className="card">
          <div className="report">{report}</div>
        </div>
      )}

      <Link href="/" className="back-link">
        ← Back to tools
      </Link>

      <footer className="muted">One report per submission. Nothing is saved.</footer>
    </>
  );
}
