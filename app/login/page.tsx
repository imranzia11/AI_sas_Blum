"use client";

import { Suspense, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { addDoc, collection, doc, getDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

// Lets a caller send the user somewhere other than /dashboard after login -
// e.g. the installed "Replies" home-screen app sets start_url to
// /login?next=/replies so opening the icon goes straight into Replies
// instead of detouring through the full desktop dashboard first. Only a
// same-site relative path is ever honored (must start with exactly one
// leading slash, never "//" which browsers treat as protocol-relative to
// another host) - this is a redirect target read from a URL query string,
// so it must never be trusted to point off-site.
function safeNextPath(value: string | null): string {
  if (!value) return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

type ThreadStep =
  | "idle"
  | "typingOut"
  | "outSent"
  | "outDelivered"
  | "typingIn"
  | "inReceived";

const STEP_SEQUENCE: { step: ThreadStep; holdMs: number }[] = [
  { step: "typingOut", holdMs: 900 },
  { step: "outSent", holdMs: 900 },
  { step: "outDelivered", holdMs: 1400 },
  { step: "typingIn", holdMs: 900 },
  { step: "inReceived", holdMs: 2600 },
];

// useSearchParams() (used below to read ?next=) requires a Suspense
// boundary in the App Router - without one, `next build` fails with
// "useSearchParams() should be wrapped in a suspense boundary" because
// Next can't prerender a static shell for a component whose output
// depends on the URL's query string. This wrapper is the entire fix -
// LoginPageInner itself is unchanged from a plain page component.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Renders a QR code so a desktop user can scan-to-open the Replies PWA
  // on their phone instead of typing the URL by hand. Left empty until
  // mount (rather than reading window.location directly during render) so
  // server-rendered HTML and the first client render match exactly - this
  // is a "use client" page, but Next.js still does an initial SSR pass
  // with no `window`, and mismatched output there is a real (if harmless)
  // hydration warning, not just a style nit.
  const [siteOrigin, setSiteOrigin] = useState("");
  useEffect(() => {
    setSiteOrigin(window.location.origin);
  }, []);

  const [threadStep, setThreadStep] = useState<ThreadStep>("idle");
  const stepIndexRef = useRef(0);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    reducedMotionRef.current =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reducedMotionRef.current) {
      setThreadStep("inReceived");
      return;
    }

    let timer: number | undefined;
    let cancelled = false;

    const runStep = () => {
      if (cancelled) return;
      const current = STEP_SEQUENCE[stepIndexRef.current];
      setThreadStep(current.step);

      timer = window.setTimeout(() => {
        stepIndexRef.current =
          (stepIndexRef.current + 1) % STEP_SEQUENCE.length;

        if (stepIndexRef.current === 0) {
          setThreadStep("idle");
          timer = window.setTimeout(runStep, 700);
        } else {
          runStep();
        }
      }, current.holdMs);
    };

    timer = window.setTimeout(runStep, 500);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const uid = cred.user.uid;

      const snap = await getDoc(doc(db, "users", uid));

      if (!snap.exists()) {
        await signOut(auth).catch(() => {});
        setError("User record not found in Firestore.");
        setLoading(false);
        return;
      }

      const data = snap.data();

      if (data.isActive !== true) {
        await signOut(auth).catch(() => {});
        setError("Access denied. Account inactive.");
        setLoading(false);
        return;
      }

      // Best-effort login record for the superadmin's per-account history
      // view - deliberately fire-and-forget. A write failure here (offline,
      // a rules hiccup, whatever) must never block a real login; it just
      // means this one sign-in is missing from the history list.
      addDoc(collection(db, "loginHistory"), {
        ownerUid: uid,
        email: String(data.email || email || ""),
        loginAt: serverTimestamp(),
      }).catch((error) => {
        console.error("Failed to record login history (non-fatal)", error);
      });

      // Superadmin never sends messages or touches the SMS portal - it
      // always lands on the cross-account overview dashboard instead of
      // wherever ?next= would otherwise send a regular user.
      if (String(data.role || "").toLowerCase() === "superadmin") {
        router.push("/admin");
        return;
      }

      router.push(nextPath);
    } catch (err: any) {
      setError(err?.message || "Login failed");
    }

    setLoading(false);
  };

  const showOutBubble =
    threadStep === "outSent" ||
    threadStep === "outDelivered" ||
    threadStep === "typingIn" ||
    threadStep === "inReceived";

  const showInBubble = threadStep === "inReceived";

  return (
    <>
      <style jsx global>{`
        @import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap");

        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        @keyframes bubbleIn {
          0% {
            opacity: 0;
            transform: translateY(6px) scale(0.98);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        @keyframes dotPulse {
          0%,
          80%,
          100% {
            opacity: 0.25;
            transform: translateY(0);
          }
          40% {
            opacity: 1;
            transform: translateY(-2px);
          }
        }

        input::placeholder {
          color: rgba(148, 163, 184, 0.7);
        }

        .wa-tail-out {
          position: relative;
        }
        .wa-tail-out::after {
          content: "";
          position: absolute;
          right: -7px;
          bottom: 0;
          width: 10px;
          height: 12px;
          background: inherit;
          clip-path: polygon(0 0, 100% 100%, 0 100%);
        }
        .wa-tail-in {
          position: relative;
        }
        .wa-tail-in::after {
          content: "";
          position: absolute;
          left: -7px;
          bottom: 0;
          width: 10px;
          height: 12px;
          background: inherit;
          clip-path: polygon(100% 0, 100% 100%, 0 100%);
        }

        @media (prefers-reduced-motion: reduce) {
          .thread-bubble {
            animation: none !important;
          }
        }

        /* Below this width the two-column grid has no room to breathe —
           the sign-in card was getting squeezed down to an unusable
           sliver. Stack to a single column and let the sign-in card take
           the full width instead; the marketing side steps aside since
           the form is what every user actually needs on a small screen. */
        @media (max-width: 860px) {
          .login-shell {
            display: block !important;
            max-width: 440px !important;
          }
          .login-left {
            display: none !important;
          }
          .login-right {
            width: 100% !important;
          }
        }
      `}</style>

      <main style={pageStyle}>
        <div style={shellStyle} className="login-shell">
          <section style={leftStyle} className="login-left">
            <div style={brandRowStyle}>
              <div style={brandIconStyle}>
              <img
                src="/logo-mark.png"
                alt=""
                aria-hidden="true"
                style={brandIconImgStyle}
              />
            </div>
              <div>
                <div style={brandTitleStyle}>Blum Marketing</div>
                <div style={brandSubStyle}>AI Marketing Platform</div>
              </div>
            </div>

            <div style={heroBadgeStyle}>WhatsApp marketing for Real Estate & Restaurants</div>

            <h1 style={heroTitleStyle}>
              Your next customer
              <br />
              is a message away.
            </h1>

            <p style={heroTextStyle}>
              Skip the cold calls. Reach buyers who are browsing listings and
              diners who are deciding where to eat — right now, on WhatsApp.
              Launch campaigns, get AI-assisted replies, and turn interested
              leads into booked viewings and reserved tables.
            </p>

            <div style={threadCardStyle}>
              <div style={threadTopBarStyle}>
                <span style={threadAvatarStyle}>S</span>
                <div style={threadHeaderTextWrapStyle}>
                  <span style={threadTopLabelStyle}>Sarah Al Mansoori</span>
                  <span style={threadTopStatusStyle}>
                    <span style={threadTopDotStyle} />
                    +971 50 123 4567 · online
                  </span>
                </div>
              </div>

              <div style={threadBodyStyle}>
                <div style={threadRowOutStyle}>
                  {showOutBubble ? (
                    <div
                      className="thread-bubble wa-tail-out"
                      style={{
                        ...threadBubbleStyle,
                        ...threadBubbleOutStyle,
                        animation: "bubbleIn 0.35s ease-out",
                      }}
                    >
                      <div style={threadBubbleTextStyle}>
                        Hi Sarah — following up on the paperwork, need
                        anything from us?
                      </div>
                      <div style={threadMetaOutStyle}>
                        <span>9:41 AM</span>
                        <span
                          style={{
                            color:
                              threadStep === "outDelivered" ||
                              threadStep === "typingIn" ||
                              threadStep === "inReceived"
                                ? "#53bdeb"
                                : "rgba(131,24,67,0.45)",
                          }}
                        >
                          {threadStep === "outSent" ? "✓" : "✓✓"}
                        </span>
                      </div>
                    </div>
                  ) : threadStep === "typingOut" ? (
                    <div
                      className="thread-bubble wa-tail-out"
                      style={{ ...typingBubbleStyle, ...typingBubbleOutStyle }}
                    >
                      <TypingDots dark />
                    </div>
                  ) : null}
                </div>

                <div style={threadRowInStyle}>
                  {showInBubble ? (
                    <div
                      className="thread-bubble wa-tail-in"
                      style={{
                        ...threadBubbleStyle,
                        ...threadBubbleInStyle,
                        animation: "bubbleIn 0.35s ease-out",
                      }}
                    >
                      <div style={threadBubbleTextInStyle}>
                        Not yet — I'll get it over by Friday!
                      </div>
                      <div style={threadMetaInStyle}>9:44 AM</div>
                    </div>
                  ) : threadStep === "typingIn" ? (
                    <div
                      className="thread-bubble wa-tail-in"
                      style={{ ...typingBubbleStyle, ...typingBubbleInStyle }}
                    >
                      <TypingDots dark />
                    </div>
                  ) : null}
                </div>
              </div>

              <div style={threadFooterStyle}>
                Reply STOP to opt out, HELP for help.
              </div>
            </div>

            <div style={featureGridStyle}>
              <FeatureCard
                icon="✨"
                title="AI-Assisted Replies"
                text="Smart suggestions help you respond to leads faster."
              />
              <FeatureCard
                icon="📣"
                title="Bulk Campaigns"
                text="Launch personalized outreach to thousands at once."
              />
              <FeatureCard
                icon="💬"
                title="Reply Tracking"
                text="See every response and follow up at the right time."
              />
              <FeatureCard
                icon="🛡️"
                title="Built-in Compliance"
                text="Opt-outs and STOP requests are handled automatically."
              />
            </div>

            {siteOrigin ? (
              <div style={qrCardStyle}>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&margin=8&data=${encodeURIComponent(
                    `${siteOrigin}/login?next=/replies`
                  )}`}
                  alt="QR code to open Replies on your phone"
                  width={96}
                  height={96}
                  style={qrImageStyle}
                />
                <div>
                  <div style={qrTitleStyle}>Scan to open on your phone</div>
                  <div style={qrTextStyle}>
                    Opens straight to sign-in, then Replies - add it to your
                    home screen for the full app experience.
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <section style={rightWrapStyle} className="login-right">
            <div style={cardStyle}>
              <div style={cardTopStyle}>
                <div style={cardBrandRowStyle}>
                  <img
                    src="/logo-mark.png"
                    alt=""
                    aria-hidden="true"
                    style={cardBrandLogoStyle}
                  />
                  <span style={cardBrandTextStyle}>Blum</span>
                </div>
                <h2 style={cardTitleStyle}>Sign in</h2>
                <p style={cardTextStyle}>
                  {nextPath === "/replies"
                    ? "Continue to Replies"
                    : "Continue to your marketing portal"}
                </p>
              </div>

              <form onSubmit={handleLogin} style={formStyle}>
                <div>
                  <label style={labelStyle}>Email address</label>
                  <input
                    type="email"
                    placeholder="you@company.com"
                    style={inputStyle}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                  />
                </div>

                <div>
                  <label style={labelStyle}>Password</label>
                  <div style={passwordWrapStyle}>
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="Enter password"
                      style={{ ...inputStyle, paddingRight: 46 }}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      style={passwordToggleStyle}
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                {error ? <div style={errorBoxStyle}>{error}</div> : null}

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    ...buttonStyle,
                    opacity: loading ? 0.75 : 1,
                    cursor: loading ? "not-allowed" : "pointer",
                  }}
                >
                  {loading ? (
                    <span style={buttonLoadingWrapStyle}>
                      <span style={spinnerStyle} />
                      Signing in...
                    </span>
                  ) : (
                    "Sign in"
                  )}
                </button>
              </form>

              <div style={cardFooterStyle}>
                Access is limited to active portal accounts.
              </div>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statItemStyle}>
      <div style={statValueStyle}>{value}</div>
      <div style={statLabelStyle}>{label}</div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  text,
}: {
  icon: string;
  title: string;
  text: string;
}) {
  return (
    <div style={featureCardStyle}>
      <div style={featureIconStyle}>{icon}</div>
      <div style={featureTitleStyle}>{title}</div>
      <div style={featureTextStyle}>{text}</div>
    </div>
  );
}

function TypingDots({ dark = false }: { dark?: boolean }) {
  const dotColor = dark ? "#64748b" : "rgba(255,255,255,0.85)";

  return (
    <div style={{ display: "flex", gap: 4, padding: "2px 0" }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: dotColor,
            display: "inline-block",
            animation: `dotPulse 1.1s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "calc(100vh / var(--ui-zoom, 1))",
  background: "linear-gradient(135deg, #be185d 0%, #db2777 48%, #ec4899 100%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "40px 20px",
  fontFamily: "'Inter', system-ui, sans-serif",
};

const shellStyle: CSSProperties = {
  width: "100%",
  maxWidth: 1360,
  display: "grid",
  gridTemplateColumns: "1.05fr 0.8fr",
  gap: 40,
  alignItems: "stretch",
};

const leftStyle: CSSProperties = {
  padding: "12px 8px",
  color: "#fff1f2",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
};

const brandRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const brandIconStyle: CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: 16,
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.16)",
  border: "1px solid rgba(255,255,255,0.28)",
  boxShadow: "0 6px 18px rgba(80,7,36,0.25)",
};

const brandIconImgStyle: CSSProperties = {
  width: 40,
  height: 40,
  objectFit: "contain",
};

const brandTitleStyle: CSSProperties = {
  fontFamily: "'Space Grotesk', sans-serif",
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1.1,
  color: "#ffffff",
};

const brandSubStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 13,
  color: "rgba(255, 255, 255, 0.7)",
  fontWeight: 500,
};

const heroBadgeStyle: CSSProperties = {
  marginTop: 32,
  width: "fit-content",
  borderRadius: 999,
  padding: "7px 14px",
  background: "rgba(255,255,255,0.14)",
  border: "1px solid rgba(255,255,255,0.24)",
  color: "#fff1f2",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "'IBM Plex Mono', monospace",
  letterSpacing: 0.2,
};

const heroTitleStyle: CSSProperties = {
  margin: "20px 0 0 0",
  fontFamily: "'Space Grotesk', sans-serif",
  fontSize: 72,
  lineHeight: 1.06,
  fontWeight: 700,
  color: "#ffffff",
  maxWidth: 640,
};

const heroTextStyle: CSSProperties = {
  margin: "20px 0 0 0",
  fontSize: 19,
  lineHeight: 1.7,
  color: "rgba(255, 255, 255, 0.86)",
  maxWidth: 540,
};

const threadCardStyle: CSSProperties = {
  marginTop: 32,
  width: "100%",
  maxWidth: 440,
  borderRadius: 20,
  overflow: "hidden",
  background: "#f3e7ec",
  boxShadow: "0 20px 50px rgba(80,7,36,0.35)",
  border: "1px solid rgba(255,255,255,0.25)",
};

const threadTopBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 16px",
  background: "linear-gradient(135deg, #9d174d 0%, #be185d 100%)",
};

const threadAvatarStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  flexShrink: 0,
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.22)",
  border: "1px solid rgba(255,255,255,0.35)",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 700,
  fontFamily: "'Space Grotesk', sans-serif",
};

const threadHeaderTextWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const threadTopDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "#4ade80",
  display: "inline-block",
  marginRight: 5,
};

const threadTopLabelStyle: CSSProperties = {
  fontFamily: "'Space Grotesk', sans-serif",
  fontSize: 13.5,
  fontWeight: 700,
  color: "#ffffff",
};

const threadTopStatusStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontSize: 11,
  color: "rgba(255,255,255,0.8)",
  fontFamily: "'IBM Plex Mono', monospace",
};

const threadBodyStyle: CSSProperties = {
  padding: "16px 14px",
  position: "relative",
  height: 148,
  background: "#f3e7ec",
};

const threadRowOutStyle: CSSProperties = {
  position: "absolute",
  top: 10,
  right: 14,
  left: 14,
  display: "flex",
  justifyContent: "flex-end",
};

const threadRowInStyle: CSSProperties = {
  position: "absolute",
  top: 86,
  right: 14,
  left: 14,
  display: "flex",
  justifyContent: "flex-start",
};

const threadBubbleStyle: CSSProperties = {
  maxWidth: "82%",
  borderRadius: 14,
  padding: "10px 13px",
};

const threadBubbleOutStyle: CSSProperties = {
  background: "#fbcfe8",
  borderBottomRightRadius: 3,
};

const threadBubbleInStyle: CSSProperties = {
  background: "#ffffff",
  borderBottomLeftRadius: 3,
  boxShadow: "0 1px 2px rgba(15,23,42,0.1)",
};

const threadBubbleTextStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "#5b0e34",
};

const threadBubbleTextInStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "#0f172a",
};

const threadMetaOutStyle: CSSProperties = {
  marginTop: 6,
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: 6,
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  color: "rgba(91,14,52,0.55)",
};

const threadMetaInStyle: CSSProperties = {
  marginTop: 6,
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  color: "#94a3b8",
};

const typingBubbleStyle: CSSProperties = {
  borderRadius: 14,
  padding: "10px 13px",
  width: "fit-content",
};

const typingBubbleOutStyle: CSSProperties = {
  background: "#fbcfe8",
  borderBottomRightRadius: 3,
};

const typingBubbleInStyle: CSSProperties = {
  background: "#ffffff",
  borderBottomLeftRadius: 3,
  boxShadow: "0 1px 2px rgba(15,23,42,0.1)",
};

const threadFooterStyle: CSSProperties = {
  padding: "10px 16px",
  borderTop: "1px solid rgba(80,7,36,0.08)",
  background: "#ece0e6",
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  color: "rgba(80, 7, 36, 0.5)",
};

const statsRowStyle: CSSProperties = {
  marginTop: 30,
  display: "flex",
  gap: 28,
};

const statItemStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const statValueStyle: CSSProperties = {
  fontFamily: "'Space Grotesk', sans-serif",
  fontSize: 20,
  fontWeight: 700,
  color: "#ffffff",
};

const statLabelStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(242,190,207, 0.55)",
};

const featureGridStyle: CSSProperties = {
  marginTop: 28,
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 12,
  maxWidth: 460,
};

const qrCardStyle: CSSProperties = {
  marginTop: 24,
  maxWidth: 460,
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: 16,
  borderRadius: 18,
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.16)",
};

const qrImageStyle: CSSProperties = {
  borderRadius: 10,
  background: "#ffffff",
  padding: 6,
  flexShrink: 0,
};

const qrTitleStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 14.5,
  color: "#ffffff",
};

const qrTextStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "rgba(255,241,242, 0.75)",
};

const featureCardStyle: CSSProperties = {
  borderRadius: 16,
  padding: 16,
  background: "rgba(80,7,36, 0.22)",
  border: "1px solid rgba(255,255,255,0.16)",
};

const featureIconStyle: CSSProperties = {
  fontSize: 18,
};

const featureTitleStyle: CSSProperties = {
  marginTop: 10,
  fontFamily: "'Space Grotesk', sans-serif",
  fontSize: 15,
  fontWeight: 700,
  color: "#ffffff",
};

const featureTextStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 13.5,
  lineHeight: 1.55,
  color: "rgba(255, 255, 255, 0.82)",
};

const rightWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const cardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 460,
  borderRadius: 26,
  padding: 40,
  background: "#fdf2f6",
  boxShadow: "0 30px 80px rgba(2,8,23,0.35)",
};

const cardTopStyle: CSSProperties = {
  textAlign: "left",
};

const cardBrandRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 18,
};

const cardBrandLogoStyle: CSSProperties = {
  width: 32,
  height: 32,
  objectFit: "contain",
};

const cardBrandTextStyle: CSSProperties = {
  fontFamily: "'Space Grotesk', sans-serif",
  fontSize: 16,
  fontWeight: 700,
  color: "#0f172a",
};

const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: "'Space Grotesk', sans-serif",
  fontSize: 32,
  lineHeight: 1.1,
  fontWeight: 700,
  color: "#0f172a",
};

const cardTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  fontSize: 15.5,
  lineHeight: 1.6,
  color: "#64748b",
};

const formStyle: CSSProperties = {
  marginTop: 28,
  display: "grid",
  gap: 18,
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: 8,
  fontSize: 14,
  fontWeight: 600,
  color: "#334155",
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 12,
  border: "1px solid #e3d7db",
  background: "#ffffff",
  color: "#0f172a",
  padding: "16px 16px",
  // 16px is the minimum that keeps iOS Safari from auto-zooming the whole
  // page in when a user taps into this field — below that threshold, the
  // browser silently zooms to make the text legible, which looks like the
  // page unexpectedly jumping/zooming for the user. Bumped further to
  // 17px so it reads clearly at a glance on any screen size.
  fontSize: 17,
  outline: "none",
};

const passwordWrapStyle: CSSProperties = {
  position: "relative",
};

const passwordToggleStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  right: 10,
  transform: "translateY(-50%)",
  border: "none",
  background: "transparent",
  color: "#be185d",
  fontSize: 12.5,
  fontWeight: 700,
  cursor: "pointer",
  padding: "6px 4px",
};

const errorBoxStyle: CSSProperties = {
  borderRadius: 12,
  padding: "12px 14px",
  background: "rgba(220, 38, 38, 0.08)",
  border: "1px solid rgba(220, 38, 38, 0.18)",
  color: "#b91c1c",
  fontSize: 13.5,
  lineHeight: 1.5,
};

const buttonStyle: CSSProperties = {
  marginTop: 6,
  width: "100%",
  border: "none",
  borderRadius: 12,
  padding: "17px 18px",
  background: "linear-gradient(135deg, #be185d 0%, #db2777 100%)",
  color: "#ffffff",
  fontSize: 17,
  fontWeight: 700,
  boxShadow: "0 14px 30px rgba(219,39,119,0.24)",
};

const buttonLoadingWrapStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  justifyContent: "center",
};

const spinnerStyle: CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: "50%",
  border: "2px solid rgba(255,255,255,0.35)",
  borderTop: "2px solid #ffffff",
  animation: "spin 1s linear infinite",
};

const cardFooterStyle: CSSProperties = {
  marginTop: 20,
  fontSize: 12,
  color: "#94a3b8",
  textAlign: "center",
};
