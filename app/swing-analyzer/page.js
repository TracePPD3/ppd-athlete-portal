"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

export default function SwingAnalyzerPage() {
  const fileInputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState("");

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

  // Single source of truth: click and drop both set `selectedFile`, and Analyze
  // reads it the same way either way.
  function chooseFile(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith("video/")) {
      setError("That doesn't look like a video file.");
      return;
    }
    setError("");
    setReport("");
    setSelectedFile(file);
  }

  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    chooseFile(file);
  }

  async function analyze() {
    if (!selectedFile) return;
    setLoading(true);
    setError("");
    setReport("");
    try {
      const form = new FormData();
      form.append("video", selectedFile);
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
        <h1>Swing Analyzer</h1>
        <div className="sub">
          Upload a swing clip (open-side view) and get a Load / Unload read.
        </div>
      </div>

      <div className="card">
        <label
          className={`file${dragging ? " dragover" : ""}`}
          htmlFor="video"
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragging(false);
          }}
          onDrop={onDrop}
        >
          <strong>Tap to choose a video</strong>
          <br />
          or drag one here — clips under 30 MB
          <input
            id="video"
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={(e) => chooseFile(e.target.files?.[0])}
          />
        </label>

        {selectedFile && <div className="filename">{selectedFile.name}</div>}

        <button
          className="primary"
          disabled={!selectedFile || loading}
          onClick={analyze}
        >
          {loading ? "Analyzing…" : "Analyze Swing"}
        </button>

        {loading && (
          <div className="status">
            <span className="spinner" />
            Extracting frames and analyzing the swing…
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

      <footer className="muted">One video, one report. Nothing is saved.</footer>
    </>
  );
}
