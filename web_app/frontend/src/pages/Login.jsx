import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../state/AuthContext";
import ReCAPTCHA from "react-google-recaptcha";

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
console.log("RECAPTCHA_SITE_KEY:", RECAPTCHA_SITE_KEY);

const Login = () => {
  const navigate = useNavigate();
  const { setAccessToken } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState("");
  const [captchaValue, setCaptchaValue] = useState(null);

  const handleSubmit = async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const email = form.email.value.trim();
    const password = form.password.value;

    try {
      setSubmitting(true);
      setStatus("");

      if (!captchaValue) {
        throw new Error("Please complete the CAPTCHA.");
      }

      const response = await fetch("/api/accounts/login/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, captcha_token: captchaValue }),
        credentials: "include",
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Login failed");
      }

      setAccessToken(data.access_token);
      navigate("/dashboard");
    } catch (err) {
      setStatus(err.message || "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-base-200">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-6">
        <div className="card w-full max-w-md bg-base-100 shadow-xl">
          <div className="card-body gap-6">
            <div className="space-y-2 text-center">
              <h1 className="text-3xl font-bold">Sign in</h1>
              <p className="text-sm text-base-content/70">
                Access your dashboard, portfolio and watchlist in one place.
              </p>
            </div>

            <form className="space-y-4" onSubmit={handleSubmit}>
              <label className="form-control w-full">
                <span className="label-text">Email</span>
                <input
                  name="email"
                  type="email"
                  placeholder="alex@example.com"
                  className="input input-bordered w-full"
                  required
                />
              </label>

              <label className="form-control w-full">
                <span className="label-text">Password</span>
                <input
                  name="password"
                  type="password"
                  placeholder="••••••••"
                  className="input input-bordered w-full"
                  required
                />
              </label>

             <div className="flex justify-center py-2">
  {RECAPTCHA_SITE_KEY ? (
    <ReCAPTCHA
      sitekey={RECAPTCHA_SITE_KEY}
      onChange={(value) => setCaptchaValue(value)}
    />
  ) : (
    <p>Loading CAPTCHA…</p>
  )}
</div>

              {status && <div className="alert alert-error text-sm">{status}</div>}

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={submitting || !captchaValue}
              >
                {submitting ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : (
                  "Continue to dashboard"
                )}
              </button>
            </form>

      
            <p className="text-center text-sm text-base-content/70">
              Need an account?{" "}
              <Link to="/signup" className="link link-primary">
                Create one now
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
