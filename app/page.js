import Link from "next/link";

// The portal home: a list of available tools. Adding a new tool later is a new
// entry here plus its own route/section (e.g. /baseball-iq).
const tools = [
  {
    href: "/swing-analyzer",
    title: "Swing Analyzer",
    desc: "Upload a swing clip and get an AI Load / Unload coaching read.",
    status: "active",
  },
  {
    title: "Baseball IQ Trainer",
    desc: "Situational decision-making drills and feedback.",
    status: "soon",
  },
];

export default function HomePage() {
  return (
    <>
      <div className="page-head">
        <h1>Training Tools</h1>
        <div className="sub">Pick a tool to get started.</div>
      </div>

      <div className="tool-grid">
        {tools.map((tool) =>
          tool.status === "active" ? (
            <Link key={tool.title} href={tool.href} className="tool active">
              <div className="tool-title">{tool.title}</div>
              <div className="tool-desc">{tool.desc}</div>
              <div className="tool-cta">Open →</div>
            </Link>
          ) : (
            <div key={tool.title} className="tool soon">
              <div className="tool-title">{tool.title}</div>
              <div className="tool-desc">{tool.desc}</div>
              <span className="pill">Coming soon</span>
            </div>
          ),
        )}
      </div>

      <footer className="muted">PPD Athlete Portal — demo build.</footer>
    </>
  );
}
