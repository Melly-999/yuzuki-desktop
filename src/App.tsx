import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  checkApiHealth,
  fetchCapabilities,
  fetchProductTruth,
  sendChatMessage,
  type CapabilityStatus,
  type ChatMode,
  type ModelRouteStatus,
} from "./lib/hermesApi";
import { humanizeSnakeCase, toCapabilityDisplayModel } from "./lib/capabilityStateAdapter";
import { DesktopShell } from "./desktop/DesktopShell";

type StatusLabel =
  | "FOUNDATION"
  | "IN PROGRESS"
  | "PLANNED"
  | "PROTOTYPE"
  | "UI CONCEPT"
  | "NOT A LIVE PRODUCT"
  | "NOT IMPLEMENTED IN THIS PROTOTYPE"
  | "DESIGNED / APPROVAL-BASED"
  | "EXPLORATORY / SPEC ONLY"
  | "COMING LATER"
  | "EXAMPLE DATA";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  /** Only present on assistant replies that actually came back from the API scaffold. */
  productTruthLabels?: string[];
};

type Reminder = {
  id: string;
  title: string;
  when: string;
  group: "Today" | "Upcoming" | "Done";
};

type TabId = "chat" | "today" | "reminders" | "search" | "settings";

type ThemeOption = {
  id: string;
  label: string;
  from: string;
  to: string;
};

const heroConversation: ChatMessage[] = [
  { id: "h1", role: "assistant", text: "Good morning 💜 Want me to help plan your day?" },
  { id: "h2", role: "user", text: "What should I focus on first?" },
  {
    id: "h3",
    role: "assistant",
    text: "You have three priorities today. I can help you work through them one at a time.",
  },
];

const CHAT_GREETING: ChatMessage = {
  id: "greeting",
  role: "assistant",
  text: "Hi, I'm HERMES 💜 I'm running as a prototype right now — my replies come from a fixed local stub, not a live AI model. Send me something and I'll show you how this will feel.",
  productTruthLabels: ["PROTOTYPE"],
};

const quickPrompts = ["Plan my day", "Help me decide", "Break down a task", "Draft a reminder"];
const personalityPresets = ["Warm", "Calm", "Focused", "Playful"];
const greetingOptions = ["Good morning ✨", "Hi there 💜", "Welcome back"];
const themeOptions: ThemeOption[] = [
  { id: "blossom", label: "Blossom", from: "#F472D0", to: "#A855F7" },
  { id: "twilight", label: "Twilight", from: "#A855F7", to: "#7C3AED" },
  { id: "orchid", label: "Orchid", from: "#C084FC", to: "#F472D0" },
];

const defaultTheme = themeOptions[0] ?? {
  id: "blossom",
  label: "Blossom",
  from: "#F472D0",
  to: "#A855F7",
};
const defaultGreeting = greetingOptions[0] ?? "Good morning ✨";
const defaultPersonality = personalityPresets[0] ?? "Warm";

const reminders: Reminder[] = [
  { id: "r1", title: "Call dentist", when: "Tomorrow · 10:00", group: "Today" },
  { id: "r2", title: "Buy flowers", when: "Friday", group: "Upcoming" },
  { id: "r3", title: "Renew subscription", when: "Next week", group: "Upcoming" },
  { id: "r4", title: "Book train tickets", when: "Yesterday", group: "Done" },
];

const roadmap = [
  { status: "FOUNDATION" as StatusLabel, items: ["Isolated assistant profile", "Safety boundaries", "Credential isolation work", "Model benchmarking"] },
  { status: "IN PROGRESS" as StatusLabel, items: ["Model routing", "Identity contract", "Memory contract"] },
  { status: "PLANNED" as StatusLabel, items: ["Web and Maps", "Calendar read", "Gmail read / search", "Reminders", "Bounded API", "iOS application", "Personalization", "Voice", "TestFlight"] },
  { status: "EXPLORATORY / SPEC ONLY" as StatusLabel, items: ["Progressive Web App (PWA)"] },
];

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function StatusBadge({ status }: { status: StatusLabel | string }) {
  const { label, tone } = toCapabilityDisplayModel(status);
  return (
    <span className={classNames("status-badge", `status-badge-${tone}`)}>
      <span aria-hidden className="status-dot" />
      {label}
    </span>
  );
}

function WingMark({ small = false }: { small?: boolean }) {
  return (
    <span className={classNames("wing-mark", small && "wing-mark-small")} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M12 3c1.6 2.15 4.25 3.28 7 3.5-.32 3.02-1.87 5.7-4.45 7.35M12 3c-1.6 2.15-4.25 3.28-7 3.5.32 3.02 1.87 5.7 4.45 7.35M12 3v15.5M9 21h6"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function NavIcon({ name }: { name: TabId }) {
  const shared = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "nav-icon",
    "aria-hidden": true,
  };
  if (name === "chat") {
    return (
      <svg {...shared}>
        <path d="M4 5h16v10.5H9l-4.5 4V5Z" />
      </svg>
    );
  }
  if (name === "today") {
    return (
      <svg {...shared}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2.2M12 19.3v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6" />
      </svg>
    );
  }
  if (name === "reminders") {
    return (
      <svg {...shared}>
        <path d="M12 3.2a5 5 0 0 0-5 5v3.1c0 .64-.22 1.26-.62 1.76L5 15h14l-1.38-2c-.4-.5-.62-1.11-.62-1.75V8.2a5 5 0 0 0-5-5Z" />
        <path d="M10 18a2 2 0 0 0 4 0" />
      </svg>
    );
  }
  if (name === "search") {
    return (
      <svg {...shared}>
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="m20 20-3.6-3.6" />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12c0-.4-.03-.8-.09-1.18l1.94-1.5-2-3.46-2.28.86a7 7 0 0 0-2.02-1.17L14.2 3H9.8l-.35 2.55a7 7 0 0 0-2.02 1.17l-2.28-.86-2 3.46 1.94 1.5A7.4 7.4 0 0 0 5 12c0 .4.03.8.09 1.18l-1.94 1.5 2 3.46 2.28-.86c.61.5 1.29.9 2.02 1.17L9.8 21h4.4l.35-2.55a7 7 0 0 0 2.02-1.17l2.28.86 2-3.46-1.94-1.5c.06-.38.09-.78.09-1.18Z" />
    </svg>
  );
}

function HermesLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="logo">
      <WingMark small={compact} />
      <span className={classNames("logo-text", compact && "logo-text-compact")}>HERMES</span>
    </span>
  );
}

function AssistantAvatar({ size = 44, halo = false }: { size?: number; halo?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      {halo && <span className="avatar-halo" aria-hidden />}
      {imageFailed ? (
        <span className="avatar-fallback" role="img" aria-label="HERMES assistant">
          <WingMark small />
        </span>
      ) : (
        <img
          className="avatar-face"
          src="/hermes-avatar-256.jpg"
          width={size}
          height={size}
          decoding="async"
          alt="HERMES anime assistant avatar"
          onError={() => setImageFailed(true)}
        />
      )}
    </span>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="site-header">
        <div className="header-inner">
          <a href="/" aria-label="HERMES home"><HermesLogo /></a>
        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="/#everyday">Everyday help</a>
          <a href="/#assistant">Meet HERMES</a>
          <a href="/#control">Control</a>
          <a href="/#roadmap">Roadmap</a>
        </nav>
        <a href="/app-preview" className="button primary desktop-cta">Preview the experience</a>
        <button
          className="menu-button"
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="mobile-site-menu"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "×" : "☰"}
        </button>
        </div>
        {open && (
          <nav id="mobile-site-menu" className="mobile-menu" aria-label="Mobile navigation">
            <a href="/#everyday" onClick={() => setOpen(false)}>Everyday help</a>
            <a href="/#assistant" onClick={() => setOpen(false)}>Meet HERMES</a>
            <a href="/#control" onClick={() => setOpen(false)}>Control</a>
            <a href="/#roadmap" onClick={() => setOpen(false)}>Roadmap</a>
            <a href="/app-preview" className="button primary">Preview the experience</a>
          </nav>
        )}
      </header>
    </>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div>
        <HermesLogo compact />
        <p>A private personal AI companion in active development. All screens and data shown are prototype examples.</p>
      </div>
      <span className="footer-mark"><WingMark small /> Prototype · Not a live product</span>
    </footer>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") return <p className="bubble user">{message.text}</p>;
  return (
    <div className="assistant-row">
      <AssistantAvatar size={28} />
      <div className="assistant-bubble-group">
        <p className="bubble assistant">{message.text}</p>
        {message.productTruthLabels && message.productTruthLabels.length > 0 && (
          <div className="bubble-labels">
            {message.productTruthLabels.map((label) => (
              <span key={label} className="bubble-label">{humanizeSnakeCase(label)}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A companion-appropriate "thinking" indicator, not a generic spinner. */
function ThinkingBubble() {
  return (
    <div className="assistant-row" role="status" aria-live="polite" aria-label="HERMES is preparing a reply">
      <AssistantAvatar size={28} />
      <p className="bubble assistant thinking-bubble">
        <span className="thinking-dot" aria-hidden />
        <span className="thinking-dot" aria-hidden />
        <span className="thinking-dot" aria-hidden />
      </p>
    </div>
  );
}

/**
 * Post-send label: rendered from the actual chat response's `mode` /
 * `model_route_status` fields — never inferred from reply text.
 */
function describeChatState(mode: ChatMode, modelRouteStatus: ModelRouteStatus): string {
  if (modelRouteStatus === "NOT_CONFIGURED") return `${mode} · model not configured`;
  return `${mode} · ${humanizeSnakeCase(modelRouteStatus).toLowerCase()}`;
}

/**
 * Pre-send label: rendered from the capability registry (`GET
 * /api/capabilities`) while the connection is being confirmed and before
 * any message has actually been sent — so this badge is never empty or
 * stuck on "checking" once the scaffold is reachable.
 */
function describePreSendState(capabilityModelRoutingStatus: CapabilityStatus | null): string {
  if (!capabilityModelRoutingStatus) return "Checking prototype status…";
  return `model routing: ${humanizeSnakeCase(capabilityModelRoutingStatus).toLowerCase()}`;
}

function ChatStatusStrip({
  apiAvailability,
  chatMode,
  modelRouteStatus,
  capabilityModelRoutingStatus,
  chatCapabilityNote,
  prototypeWarning,
}: {
  apiAvailability: "checking" | "reachable" | "unreachable";
  chatMode: ChatMode | null;
  modelRouteStatus: ModelRouteStatus | null;
  capabilityModelRoutingStatus: CapabilityStatus | null;
  chatCapabilityNote: string | null;
  prototypeWarning: string | null;
}) {
  if (apiAvailability === "unreachable") return null; // the unavailable banner already covers this
  const label =
    chatMode && modelRouteStatus
      ? describeChatState(chatMode, modelRouteStatus)
      : describePreSendState(capabilityModelRoutingStatus);
  // One calm metadata block: the badge carries the honest mode/route
  // facts; the API-provided notes render as a single quieter line each,
  // instead of separate paragraphs competing above the conversation.
  return (
    <div className="chat-status-strip">
      <StatusBadge status={label.toUpperCase()} />
      {chatCapabilityNote && <p className="muted tiny chat-status-note">{chatCapabilityNote}</p>}
      {prototypeWarning && <p className="muted tiny chat-status-note">{prototypeWarning}</p>}
    </div>
  );
}

function ChatUnavailableBanner({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div className="chat-error-banner chat-unavailable-banner" role="alert">
      <strong>I can't reach my prototype backend right now.</strong>
      <p>This chat is a wired prototype, not a live model — once my local scaffold is back, I'll pick right up where we left off.</p>
      <button type="button" className="button secondary chat-retry" onClick={onRetry} disabled={retrying}>
        {retrying ? "Checking…" : "Try again"}
      </button>
      <p className="chat-banner-note">
        Prototype note: start the local API scaffold with <code>npm run api:dev</code>.
      </p>
    </div>
  );
}

/**
 * Renders only the server's normalized, safe `message` string — never
 * `ChatErrorBody.echoed_message`. That field can carry the exact
 * credential-shaped text the user just typed; this component's props
 * deliberately have no way to receive it, so a future edit cannot wire
 * it in by accident. See the field's doc comment in hermesApi.ts.
 */
function ChatErrorBanner({ message }: { message: string }) {
  return (
    <div className="chat-error-banner chat-validation-banner" role="alert">
      <strong>That message didn't go through.</strong>
      <p>{message}</p>
    </div>
  );
}

function ChatInput() {
  return (
    <form className="chat-input" onSubmit={(event) => event.preventDefault()}>
      <input disabled placeholder="Message HERMES..." aria-label="Message HERMES" />
      <span>Demo</span>
    </form>
  );
}

/** Composer grows with content up to this height, then scrolls internally. */
const COMPOSER_MAX_HEIGHT_PX = 160;

/**
 * The real, wired composer used only on the /app-preview chat screen.
 * `ChatInput` above stays a static demo element on the marketing hero —
 * only this component talks to the API scaffold.
 */
function LiveChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  busy,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Dependency-free autosize: measure natural content height each time the
  // draft changes, capped at COMPOSER_MAX_HEIGHT_PX so the composer can
  // never grow to consume the whole phone screen (CSS max-height + overflow
  // is the fallback if this effect doesn't run).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset to 0 (not "auto") before measuring: "auto" falls back to the
    // browser's rows-attribute intrinsic sizing, which overshoots the CSS
    // line-height. CSS min-height (44px) is the floor either way.
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [value]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // Enter sends (matching the prior single-line input's native submit
    // behavior); Shift+Enter inserts a newline via the browser default.
    event.preventDefault();
    if (disabled || value.trim().length === 0) return;
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className="chat-input" onSubmit={onSubmit}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="Message HERMES. Press Enter to send, Shift and Enter for a new line."
        disabled={disabled}
        maxLength={4000}
        rows={1}
      />
      <button
        type="submit"
        className="chat-send"
        disabled={disabled || value.trim().length === 0}
        aria-label="Send message"
      >
        {busy ? "…" : "Send"}
      </button>
    </form>
  );
}

function PhoneMockup({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <div className="phone-outer">
      <div className="phone-frame">
        <div className="phone-notch" aria-hidden />
        <div className="phone-screen">{children}</div>
      </div>
      {label && (
        <p className="phone-label">
          <span className="phone-label-chip">
            <WingMark small />
            {label}
          </span>
        </p>
      )}
    </div>
  );
}

function HeroPhone() {
  return (
    <PhoneMockup label="Prototype — example conversation">
      <div className="screen-scroll hero-phone-screen">
        <header className="phone-header">
          <AssistantAvatar size={40} halo />
          <div>
            <p className="phone-title">HERMES</p>
            <p className="muted tiny">Prototype companion</p>
          </div>
        </header>
        <StatusBadge status="EXAMPLE DATA" />
        <div className="conversation">
          {heroConversation.map((message) => <ChatBubble key={message.id} message={message} />)}
        </div>
        <div className="phone-input-bottom"><ChatInput /></div>
      </div>
    </PhoneMockup>
  );
}

function Section({ id, eyebrow, title, copy, children }: { id?: string; eyebrow?: string; title: string; copy?: string; children?: React.ReactNode }) {
  return (
    <section id={id} className="section">
      <div className="section-inner">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
        {copy && <p className="section-copy">{copy}</p>}
        {children}
      </div>
    </section>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="hero-glow" aria-hidden />
      <div className="hero-grid">
        <div className="hero-content">
          <StatusBadge status="PRIVATE PERSONAL AI • PROTOTYPE" />
          <h1>Your AI assistant. <span>Built around you.</span></h1>
          <p className="hero-copy">HERMES is a personal AI companion prototype for thinking, planning, and reviewing everyday decisions—with visible boundaries around what it can do.</p>
          <p className="hero-promise">Personal when you want it. Careful when it matters.</p>
          <div className="cta-row">
            <a href="/app-preview" className="button primary">Preview the experience</a>
            <a href="/#control" className="button secondary">How it stays in your control</a>
          </div>
          <ul className="hero-boundaries" aria-label="Prototype boundaries">
            <li>No account required</li>
            <li>No connected tools</li>
            <li>Nothing is sent or saved</li>
          </ul>
        </div>
        <div className="hero-phone-wrap">
          <StatusBadge status="UI CONCEPT" />
          <HeroPhone />
        </div>
      </div>
    </section>
  );
}

function ProductUnderstanding() {
  return (
    <Section
      id="everyday"
      eyebrow="What the prototype demonstrates"
      title="One calm place to think, plan, and review."
      copy="Explore the interaction model through concrete scenarios. The preview is honest about which parts are local, example-only, or unavailable."
    >
      <div className="experience-map">
        <article className="experience-primary">
          <div className="experience-heading">
            <StatusBadge status="PROTOTYPE" />
            <span>Local deterministic chat stub</span>
          </div>
          <h3>Start with a conversation, not a dashboard.</h3>
          <p>Use the chat preview to break down a decision, shape a plan, or draft a reminder idea. Replies are fixed prototype output—not a live model.</p>
          <ul className="experience-list">
            <li>Work through one decision at a time</li>
            <li>See honest thinking, unavailable, and retry states</li>
            <li>Keep consequential actions outside the chat flow</li>
          </ul>
          <a className="text-link" href="/app-preview">Open the chat-first preview <span aria-hidden>→</span></a>
        </article>
        <div className="experience-support">
          <article className="experience-support-item">
            <StatusBadge status="EXAMPLE DATA" />
            <div>
              <h3>See how a day could come together.</h3>
              <p>Today, Reminders, and Search show static scenarios so you can understand the intended rhythm without mistaking them for connected services.</p>
            </div>
          </article>
          <article className="experience-support-item">
            <StatusBadge status="PLANNED" />
            <div>
              <h3>Connected help comes later.</h3>
              <p>Email, Calendar, Search, Maps, reminders, and voice are not connected or implemented in this prototype.</p>
            </div>
          </article>
        </div>
      </div>
    </Section>
  );
}

function MeetHermes() {
  const [portraitFailed, setPortraitFailed] = useState(false);
  return (
    <section id="assistant" className="section split-section">
      {portraitFailed ? (
        <div className="portrait-card portrait-card-fallback" aria-label="HERMES assistant portrait unavailable">
          <WingMark />
          <p className="eyebrow">HERMES assistant</p>
          <h3>Meet HERMES.</h3>
          <p>The portrait is unavailable, but the product story and its boundaries remain fully readable.</p>
        </div>
      ) : (
        <div className="portrait-card portrait-card-image" aria-label="HERMES assistant character artwork">
          <picture className="portrait-picture">
            <source
              media="(max-width: 820px)"
              srcSet="/hermes-portrait-phone.jpg"
            />
            <img
              className="portrait-image"
              src="/hermes-portrait.jpg"
              width={1600}
              height={2000}
              loading="lazy"
              decoding="async"
              alt="HERMES anime companion character artwork"
              onError={() => setPortraitFailed(true)}
            />
          </picture>
        </div>
      )}
      <div>
        <p className="eyebrow">Your assistant</p>
        <h2>Helpful without taking over.</h2>
        <p className="section-copy">HERMES gives the prototype a consistent voice and visual presence while staying clear that it is software—not a person, and not a hidden autonomous agent.</p>
        <div className="principles">
          <div className="principle-row"><span aria-hidden>01</span><div><strong>Warm, not manipulative</strong><p>Supportive language without dependency cues or simulated emotion.</p></div></div>
          <div className="principle-row"><span aria-hidden>02</span><div><strong>Personalization stays visible</strong><p>Prototype-local presentation choices never pretend to be a saved profile.</p></div></div>
          <div className="principle-row"><span aria-hidden>03</span><div><strong>Decisions stay yours</strong><p>Important outcomes remain separate from ordinary conversation.</p></div></div>
        </div>
      </div>
    </section>
  );
}

function ApprovalSection() {
  const [demoOutcome, setDemoOutcome] = useState<string>("Non-functional example: no Calendar connection exists, and these controls cannot create anything.");
  return (
    <Section
      id="control"
      eyebrow="You stay in control"
      title="Review the exact change before anything happens."
      copy="This permission rehearsal demonstrates the intended decision pattern only. UI presentation is not runtime enforcement, and no external action is available in this prototype."
    >
      <div className="approval-grid">
        <div className="approval-card decision-surface" aria-labelledby="approval-demo-title" aria-describedby="approval-demo-note">
          <div className="approval-top"><strong>Permission pattern preview</strong><StatusBadge status="UI CONCEPT" /></div>
          <h3 id="approval-demo-title">Review a proposed calendar event</h3>
          <div className="event-card">
            <span className="event-icon" aria-hidden>◇</span>
            <div><strong>Dentist</strong><p>Tuesday · 14:30 · 60 min</p></div>
            <StatusBadge status="EXAMPLE DATA" />
          </div>
          <ol className="approval-steps" aria-label="What this proposal can and cannot do">
            <li className="tier-stop reached" data-tier="read">
              <span className="tier-dot" aria-hidden />
              <div><strong>READ</strong><p>Reads the calendar entry you're reviewing — example data</p></div>
            </li>
            <li className="tier-stop reached" data-tier="draft">
              <span className="tier-dot" aria-hidden />
              <div><strong>DRAFT</strong><p>Prepares the proposed change for your review</p></div>
            </li>
            <li className="tier-stop unavailable" data-tier="write-local">
              <span className="tier-dot" aria-hidden />
              <div><strong>WRITE_LOCAL</strong><p>Unavailable — nothing is saved</p></div>
            </li>
            <li className="tier-stop unavailable" data-tier="external">
              <span className="tier-dot" aria-hidden />
              <div><strong>EXTERNAL_ACTION</strong><p>Will not send. Will not contact anyone.</p></div>
            </li>
          </ol>
          <div className="approval-actions">
            <button type="button" className="button secondary" onClick={() => setDemoOutcome("Decision preview: declined. Nothing happened.")}>Not now</button>
            <button type="button" className="button primary" onClick={() => setDemoOutcome("Decision preview only: nothing was created, sent, or saved.")}>Preview approval</button>
          </div>
          <p id="approval-demo-note" className="decision-note" aria-live="polite">{demoOutcome}</p>
        </div>
        <aside className="approval-explainer" aria-labelledby="approval-explainer-title">
          <StatusBadge status="NOT IMPLEMENTED IN THIS PROTOTYPE" />
          <h3 id="approval-explainer-title">The boundary is part of the experience.</h3>
          <div className="boundary-list">
            <div><span aria-hidden>01</span><p><strong>See the proposed action.</strong> The target and material details stay in view.</p></div>
            <div><span aria-hidden>02</span><p><strong>Choose deliberately.</strong> Nothing is preselected or approved by dismissal.</p></div>
            <div><span aria-hidden>03</span><p><strong>Trust observed outcomes.</strong> A button press alone never becomes a success claim.</p></div>
          </div>
          <div className="memory-note">
            <StatusBadge status="DESIGNED / APPROVAL-BASED" />
            <p>Persistent memory follows the same review-first idea, but no memory store or write exists in this prototype.</p>
          </div>
        </aside>
      </div>
    </Section>
  );
}

function ProductTruthSection() {
  const truthItems: Array<{ title: string; status: StatusLabel; detail: string }> = [
    {
      title: "Conversation preview",
      status: "PROTOTYPE",
      detail: "A local deterministic stub can demonstrate the chat flow. No live model is connected.",
    },
    {
      title: "Today, Reminders, and Search",
      status: "EXAMPLE DATA",
      detail: "Static scenarios demonstrate navigation and hierarchy. No account or data source is connected.",
    },
    {
      title: "Memory and external actions",
      status: "NOT IMPLEMENTED IN THIS PROTOTYPE",
      detail: "Nothing is stored, sent, scheduled, purchased, or executed.",
    },
    {
      title: "Presentation choices",
      status: "PROTOTYPE",
      detail: "Theme and tone controls are local to the current preview and are not a persistent profile.",
    },
  ];
  return (
    <Section
      eyebrow="Product truth"
      title="Know what you are exploring at every step."
      copy="Premium should mean precise. HERMES keeps prototype behavior, example content, and future capability visibly separate."
    >
      <div className="truth-layout">
        <div className="truth-ledger">
          {truthItems.map((item) => (
            <article className="truth-row" key={item.title}>
              <div><h3>{item.title}</h3><p>{item.detail}</p></div>
              <StatusBadge status={item.status} />
            </article>
          ))}
        </div>
        <aside className="trust-note">
          <WingMark />
          <p className="eyebrow">Visible boundaries</p>
          <h3>The interface explains control. It does not claim to enforce it.</h3>
          <p>Real permission decisions remain a Runtime responsibility. Unknown capability state stays unavailable rather than becoming an optimistic checkmark.</p>
          <a className="text-link" href="/#control">See the permission pattern <span aria-hidden>→</span></a>
        </aside>
      </div>
    </Section>
  );
}

function MarketingHome() {
  return (
    <>
      <Header />
      <main id="main-content" tabIndex={-1}>
        <Hero />
        <ProductUnderstanding />
        <MeetHermes />
        <ApprovalSection />
        <ProductTruthSection />
        <Section id="roadmap" eyebrow="Roadmap, not availability" title="Built carefully, step by step." copy="These labels describe development direction. They do not indicate a connected or production-ready capability.">
          <div className="roadmap-list">
            {roadmap.map((group) => (
              <article className="roadmap-item" key={group.status}>
                <StatusBadge status={group.status} />
                <ul className="roadmap-items">{group.items.map((item) => <li key={item}>{item}</li>)}</ul>
              </article>
            ))}
          </div>
        </Section>
        <section className="final-cta">
          <StatusBadge status="NOT A LIVE PRODUCT" />
          <h2>Personal AI should fit into your life — not take it over.</h2>
          <p>Explore the current UI prototype, including its limitations, example data, and review-first interaction model.</p>
          <div className="cta-row centered">
            <a href="/app-preview" className="button primary">Explore the prototype</a>
            <a href="/#roadmap" className="button secondary">See the roadmap</a>
          </div>
          <p className="final-note">No connected tools. Nothing is sent, stored, or executed.</p>
        </section>
      </main>
      <Footer />
    </>
  );
}

function ScreenShell({
  children,
  scrollRef,
  onScroll,
}: {
  children: React.ReactNode;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="screen-scroll app-screen" ref={scrollRef} onScroll={onScroll}>
      {children}
    </div>
  );
}

type ApiAvailability = "checking" | "reachable" | "unreachable";

function ChatScreen() {
  const mountedRef = useRef(true);
  const sendInFlightRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keeps the latest reply (and the composer below it) clear of the
  // absolutely-positioned bottom nav, which overlaps the scroll container
  // rather than shrinking it. Content growth alone doesn't move scrollTop,
  // so without this the settled post-reply position can leave the new
  // reply's labels hidden behind the nav. Scrolling is skipped when the
  // user has deliberately scrolled up to read earlier messages.
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const NEAR_BOTTOM_THRESHOLD_PX = 120;

  function handleConversationScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX;
  }

  const [messages, setMessages] = useState<ChatMessage[]>([CHAT_GREETING]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [apiAvailability, setApiAvailability] = useState<ApiAvailability>("checking");
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [chatCapabilityNote, setChatCapabilityNote] = useState<string | null>(null);
  const [capabilityModelRoutingStatus, setCapabilityModelRoutingStatus] = useState<CapabilityStatus | null>(null);
  const [prototypeWarning, setPrototypeWarning] = useState<string | null>(null);
  const [chatMode, setChatMode] = useState<ChatMode | null>(null);
  const [modelRouteStatus, setModelRouteStatus] = useState<ModelRouteStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !wasNearBottomRef.current) return;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion ? "auto" : "smooth" });
  }, [messages]);

  function runHealthCheck(signal?: AbortSignal) {
    setCheckingConnection(true);
    checkApiHealth(signal)
      .then((outcome) => {
        if (!mountedRef.current) return;
        const reachable = outcome.kind === "reachable";
        setApiAvailability(reachable ? "reachable" : "unreachable");
        // A successful reconnect makes the last send-failure banner stale.
        if (reachable) setErrorMessage(null);
      })
      .finally(() => {
        if (mountedRef.current) setCheckingConnection(false);
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    runHealthCheck(controller.signal);

    fetchCapabilities(controller.signal).then((data) => {
      if (!mountedRef.current || !data) return;
      const note = data.capabilities.chat?.note;
      if (note) setChatCapabilityNote(note);
      const routingStatus = data.capabilities.model_routing?.status;
      if (routingStatus) setCapabilityModelRoutingStatus(routingStatus);
    });

    fetchProductTruth(controller.signal).then((data) => {
      if (!mountedRef.current || !data) return;
      setPrototypeWarning(data.prototype_warning);
    });

    return () => controller.abort();
  }, []);

  async function sendText(text: string) {
    const trimmed = text.trim();
    // `sendInFlightRef` (not the `sending` state) is the actual guard.
    // React state updates aren't visible until the next render, so two
    // sendText calls dispatched in the same tick (e.g. a scripted
    // double-click, or a very fast double-tap before React re-renders
    // the disabled composer) would both read stale `sending: false` and
    // both pass a state-only guard. A ref mutates synchronously, so the
    // second call always sees it set by the first, before either has
    // awaited anything.
    if (!trimmed || sendInFlightRef.current || apiAvailability !== "reachable") return;
    sendInFlightRef.current = true;

    setSending(true);
    setErrorMessage(null);

    const outcome = await sendChatMessage(trimmed);
    sendInFlightRef.current = false;
    if (!mountedRef.current) return;
    setSending(false);

    if (outcome.kind === "success") {
      setMessages((prev) => [
        ...prev,
        { id: `user-${outcome.data.turn_id}`, role: "user", text: trimmed },
        {
          id: outcome.data.turn_id,
          role: "assistant",
          text: outcome.data.reply,
          productTruthLabels: outcome.data.product_truth_labels,
        },
      ]);
      setChatMode(outcome.data.mode);
      setModelRouteStatus(outcome.data.model_route_status);
      setDraft("");
      return;
    }

    if (outcome.kind === "api_error") {
      // Only the normalized `message` is stored/rendered — never
      // `outcome.error.echoed_message` (see its doc comment in
      // hermesApi.ts). For most rejections the draft is left untouched so
      // the user can see and edit exactly what they typed. The one
      // exception is a credential-shaped rejection: leaving a key/token-
      // shaped string sitting visibly in the composer is exactly the kind
      // of thing this feature exists to avoid surfacing, so that case
      // clears the draft instead of leaving it on screen.
      if (outcome.error.error === "CREDENTIAL_SHAPED_INPUT_REJECTED") {
        setDraft("");
      }
      setErrorMessage(outcome.error.message);
      return;
    }

    // Network-unreachable already renders `ChatUnavailableBanner`
    // (driven by `apiAvailability`); don't also set `errorMessage`, or
    // the generic `ChatErrorBanner` stacks a second, redundant "it
    // didn't go through" message right below it.
    setErrorMessage(null);
    setApiAvailability("unreachable");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendText(draft);
  }

  const inputDisabled = sending || apiAvailability !== "reachable";
  // R4: while a message is merely in flight, say "thinking" — the
  // reconnecting copy is reserved for the genuinely unreachable state.
  const composerPlaceholder = sending
    ? "HERMES is thinking…"
    : apiAvailability !== "reachable"
      ? "Reconnecting to the prototype backend…"
      : "Message HERMES...";

  return (
    <ScreenShell scrollRef={scrollRef} onScroll={handleConversationScroll}>
      <header className="phone-header"><AssistantAvatar size={40} halo /><div><h2 className="phone-title">HERMES</h2><p className="muted tiny">Prototype companion</p></div></header>
      <ChatStatusStrip
        apiAvailability={apiAvailability}
        chatMode={chatMode}
        modelRouteStatus={modelRouteStatus}
        capabilityModelRoutingStatus={capabilityModelRoutingStatus}
        chatCapabilityNote={chatCapabilityNote}
        prototypeWarning={prototypeWarning}
      />
      {apiAvailability === "unreachable" && (
        <ChatUnavailableBanner onRetry={() => runHealthCheck()} retrying={checkingConnection} />
      )}
      {errorMessage && <ChatErrorBanner message={errorMessage} />}
      <div className="conversation">
        {messages.map((message) => <ChatBubble key={message.id} message={message} />)}
        {sending && <ThinkingBubble />}
      </div>
      <div className="prompt-row">
        {quickPrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="prompt-chip"
            disabled={inputDisabled}
            onClick={() => void sendText(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
      <LiveChatInput value={draft} onChange={setDraft} onSubmit={handleSubmit} disabled={inputDisabled} busy={sending} placeholder={composerPlaceholder} />
    </ScreenShell>
  );
}

function TodayScreen() {
  return (
    <ScreenShell>
      <h2>{defaultGreeting}</h2>
      <p className="muted">A static example of how a calm day view could feel.</p>
      <div className="mini-card"><StatusBadge status="EXAMPLE DATA" /><h3>Today's plan</h3><p>11:00 Design review · 14:30 Dentist · 17:15 Call with Maya</p></div>
      <div className="mini-card"><StatusBadge status="PLANNED" /><h3>Important messages</h3><p>Example preview only. No Gmail account or inbox is connected.</p></div>
      <div className="mini-card"><StatusBadge status="EXAMPLE DATA" /><h3>Reminders</h3><p>Call dentist · Buy flowers. No reminders backend exists.</p></div>
    </ScreenShell>
  );
}

function RemindersScreen() {
  const [tab, setTab] = useState<Reminder["group"]>("Today");
  const items = reminders.filter((item) => item.group === tab);
  return (
    <ScreenShell>
      <h2>Reminders</h2>
      <div className="pill-row">{(["Today", "Upcoming", "Done"] as const).map((item) => <button className={classNames("pill", tab === item && "active")} type="button" key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{item}</button>)}</div>
      <StatusBadge status="EXAMPLE DATA" />
      <div className="reminder-list">{items.map((item) => <div className="reminder" key={item.id}><span /> <div><strong>{item.title}</strong><p>{item.when}</p></div></div>)}</div>
    </ScreenShell>
  );
}

function SearchScreen() {
  const categories: Array<{ label: string; status: StatusLabel }> = [
    { label: "Web", status: "PLANNED" },
    { label: "Places", status: "PLANNED" },
    { label: "Email", status: "PLANNED" },
    { label: "Memory", status: "DESIGNED / APPROVAL-BASED" },
  ];
  return (
    <ScreenShell>
      <h2>What are you looking for?</h2>
      <StatusBadge status="EXAMPLE DATA" />
      <p className="muted search-intro">A non-functional preview. No live data source is connected.</p>
      <div className="search-box" aria-label="Unavailable search field preview"><span aria-hidden>⌕</span> Search field preview — unavailable</div>
      <div className="category-grid">{categories.map((item) => <div key={item.label}>{item.label}<small>{item.status}</small></div>)}</div>
      <div className="mini-card"><StatusBadge status="EXAMPLE DATA" /><h3>Quiet cafés with good light</h3><p>Example result showing how sources would appear in a conversation.</p></div>
      <div className="mini-card"><StatusBadge status="EXAMPLE DATA" /><h3>Café Rosetta</h3><p>Open until 18:00 · 400 m · Example place</p></div>
    </ScreenShell>
  );
}

function Row({ label, value, status }: { label: string; value?: string; status?: string }) {
  return <div className="settings-row"><span>{label}</span>{status ? <StatusBadge status={status} /> : <span>{value}</span>}</div>;
}

function SettingsScreen() {
  const [theme, setTheme] = useState(defaultTheme.id);
  const [personality, setPersonality] = useState(defaultPersonality);
  return (
    <ScreenShell>
      <h2>Make HERMES yours.</h2>
      <p className="muted settings-intro">Prototype-local presentation choices. They are not stored as a persistent profile.</p>
      <section className="settings-card">
        <h3>Assistant</h3>
        <Row label="Display name" value="HERMES" />
        <Row label="Avatar" value="Anime companion" />
        <Row label="Greeting" value={defaultGreeting} />
        <div className="pill-row">{personalityPresets.map((preset) => <button className={classNames("pill", personality === preset && "active")} type="button" key={preset} aria-pressed={personality === preset} onClick={() => setPersonality(preset)}>{preset}</button>)}</div>
        <div className="theme-row">{themeOptions.map((item) => <button type="button" key={item.id} aria-label={`Theme ${item.label}`} aria-pressed={theme === item.id} className={classNames("theme-dot", theme === item.id && "selected")} style={{ backgroundImage: `linear-gradient(135deg, ${item.from}, ${item.to})` }} onClick={() => setTheme(item.id)} />)}</div>
      </section>
      <section className="settings-card">
        <h3>Privacy & control</h3>
        <Row label="Memory" status="DESIGNED / APPROVAL-BASED" />
        <Row label="Connected tools" status="NOT IMPLEMENTED IN THIS PROTOTYPE" />
        <Row label="Notifications" status="PLANNED" />
      </section>
    </ScreenShell>
  );
}

function BottomNavigation({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "today", label: "Today" },
    { id: "reminders", label: "Reminders" },
    { id: "search", label: "Search" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <nav className="bottom-nav" aria-label="Prototype app navigation">
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          className={active === tab.id ? "active" : ""}
          aria-current={active === tab.id ? "page" : undefined}
          onClick={() => onChange(tab.id)}
        >
          <NavIcon name={tab.id} />
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

function ScreenByTab({ tab }: { tab: TabId }) {
  if (tab === "chat") return <ChatScreen />;
  if (tab === "today") return <TodayScreen />;
  if (tab === "reminders") return <RemindersScreen />;
  if (tab === "search") return <SearchScreen />;
  return <SettingsScreen />;
}

function AppPreview() {
  const [tab, setTab] = useState<TabId>("chat");
  return (
    <>
      <Header />
      <main id="main-content" className="preview-page" tabIndex={-1}>
        <div className="preview-heading">
          <StatusBadge status="PROTOTYPE" />
          <h1>Explore the experience—with the boundaries in view.</h1>
          <p>Chat is the primary surface. The other destinations demonstrate the product shape with static examples, not connected accounts.</p>
        </div>
        <div className="preview-layout">
          <aside className="preview-scope" aria-labelledby="preview-scope-title">
            <p className="eyebrow">Before you begin</p>
            <h2 id="preview-scope-title">What this preview can show</h2>
            <div className="preview-scope-list">
              <div><StatusBadge status="PROTOTYPE" /><p>Chat can demonstrate a local deterministic reply when the local scaffold is running. No live model is connected.</p></div>
              <div><StatusBadge status="EXAMPLE DATA" /><p>Today, Reminders, and Search use static content. No account or source is connected.</p></div>
              <div><StatusBadge status="NOT IMPLEMENTED IN THIS PROTOTYPE" /><p>Persistent memory, connected tools, and external actions are unavailable.</p></div>
            </div>
          </aside>
          <PhoneMockup label="Interactive UI concept — example data">
            <div className="phone-content"><ScreenByTab tab={tab} /><BottomNavigation active={tab} onChange={setTab} /></div>
          </PhoneMockup>
        </div>
        <div className="centered back-link"><a href="/" className="button secondary">Back to overview</a></div>
      </main>
      <Footer />
    </>
  );
}

export default function App() {
  const path = window.location.pathname;
  if (path === "/app-preview") return <AppPreview />;
  if (path === "/desktop") return <DesktopShell />;
  return <MarketingHome />;
}
