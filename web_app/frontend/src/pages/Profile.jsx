import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../state/AuthContext";
import { CURRENCY_CHANGED_EVENT } from "../hooks/useUserCurrency";

const Profile = () => {
  const { authFetch, logout } = useAuth();
  const [settings, setSettings] = useState(null);
  const [originalSettings, setOriginalSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current: "", newPassword: "", confirmPassword: "" });
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState(null);

  useEffect(() => {
    async function fetchProfile() {
      try {
        const response = await authFetch("/api/accounts/profile/");
        if (!response || typeof response !== "object") {
          throw new Error("Invalid response from server");
        }
        if (response.code !== 0 && response.data == null) {
          throw new Error(response.detail || "Server returned an error");
        }

        const data = response.data ?? response;

        const profileData = {
          displayName: data.display_name || "",
          email: data.email || "",
          currency: data.preferred_currency || "USD",
          timezone: data.timezone || "UTC",
          dateFormat: data.date_format || "YYYY-MM-DD",
        };

        setSettings(profileData);
        setOriginalSettings(profileData);
      } catch (err) {
        console.error("Failed to fetch profile:", err);
        setError("Failed to load profile data");
      } finally {
        setLoading(false);
      }
    }

    fetchProfile();
  }, [authFetch]);

  const isDirty = useMemo(() => {
    if (!settings || !originalSettings) return false;
    return Object.keys(originalSettings).some(
      (k) => settings[k] !== originalSettings[k]
    );
  }, [settings, originalSettings]);

  const handleChange = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!settings) return;

    try {
      const updateData = {
        display_name: settings.displayName,
        preferred_currency: settings.currency,
        timezone: settings.timezone,
        date_format: settings.dateFormat,
      };

      const response = await authFetch("/api/accounts/profile/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updateData),
      });

      const result = response?.data ?? response;
      if (!result) throw new Error("No data received");

      const prevCurrency = originalSettings?.currency;
      const nextCurrency = settings.currency;

      setOriginalSettings(settings);
      if (nextCurrency && nextCurrency !== prevCurrency) {
        window.dispatchEvent(
          new CustomEvent(CURRENCY_CHANGED_EVENT, {
            detail: { currency: nextCurrency },
          })
        );
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error("Failed to update profile:", err);
      setError("Failed to save changes");
    }
  };

  const handleResetPortfolio = async () => {
    const ok = window.confirm(
      "This will remove all holdings and transactions for your portfolio on the server. This cannot be undone. Continue?"
    );
    if (!ok) return;
    try {
      setResetting(true);
      await authFetch("/api/portfolio/", { method: "DELETE" });
      setActionMsg({ type: "success", text: "Portfolio reset successfully." });
    } catch (err) {
      console.error("Reset portfolio failed:", err);
      setActionMsg({ type: "error", text: err.message || "Failed to reset portfolio" });
    } finally {
      setResetting(false);
      setTimeout(() => setActionMsg(null), 3000);
    }
  };

  const handleLogout = async () => {
    const ok = window.confirm("Are you sure you want to sign out?");
    if (!ok) return;
    try {
      setLogoutPending(true);
      await logout();
    } catch (err) {
      console.error("Logout failed:", err);
      setActionMsg({ type: "error", text: "Logout failed. Please try again." });
      setTimeout(() => setActionMsg(null), 3000);
      setLogoutPending(false);
    }
  };

  const showPasswordMessage = (type, text) => {
    setPasswordMsg({ type, text });
    setTimeout(() => setPasswordMsg(null), 4000);
  };

  const handlePasswordSubmit = async (event) => {
    event.preventDefault();
    if (!passwordForm.current.trim() || !passwordForm.newPassword.trim()) {
      showPasswordMessage("error", "Please fill in all password fields.");
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      showPasswordMessage("error", "New passwords do not match.");
      return;
    }
    try {
      setPasswordPending(true);
      await authFetch("/api/accounts/change-password/", {
        method: "POST",
        body: JSON.stringify({
          current_password: passwordForm.current,
          new_password: passwordForm.newPassword,
          confirm_password: passwordForm.confirmPassword,
        }),
      });
      showPasswordMessage("success", "Password updated successfully.");
      setPasswordForm({ current: "", newPassword: "", confirmPassword: "" });
    } catch (err) {
      showPasswordMessage("error", err.message || "Failed to update password.");
    } finally {
      setPasswordPending(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-base-200 flex items-center justify-center">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-base-200 flex items-center justify-center">
        <div className="alert alert-error">
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="min-h-screen bg-base-200 flex items-center justify-center">
        <div className="alert alert-warning">
          <span>No profile data available</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-200">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-semibold uppercase text-primary">Profile Settings</p>
          <h1 className="text-3xl font-bold text-base-content md:text-4xl">Account Preferences</h1>
          <p className="text-base text-base-content/70 md:max-w-2xl">
            Customize your CryptoDash experience.
          </p>
          {error && (
            <div className="alert alert-error mt-2">
              <span>{error}</span>
            </div>
          )}
        </header>

        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-6">
            <form onSubmit={handleSubmit} className="card bg-base-100 shadow">
            <div className="card-body gap-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <h2 className="card-title text-2xl">Account information</h2>
                {saved && <div className="badge badge-success badge-outline">Saved</div>}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="form-control">
                  <div className="label">
                    <span className="label-text">Display name</span>
                  </div>
                  <input
                    type="text"
                    value={settings.displayName}
                    onChange={(e) => handleChange("displayName", e.target.value)}
                    className="input input-bordered"
                  />
                </label>

                <label className="form-control">
                  <div className="label">
                    <span className="label-text">Email address</span>
                  </div>
                  <input
                    type="email"
                    value={settings.email}
                    className="input input-bordered input-disabled"
                    readOnly
                  />
                </label>
              </div>

              <section className="grid gap-4 md:grid-cols-3">
                <label className="form-control">
                  <div className="label">
                    <span className="label-text">Preferred currency</span>
                  </div>
                  <select
                    className="select select-bordered"
                    value={settings.currency}
                    onChange={(e) => handleChange("currency", e.target.value)}
                  >
                    <option value="USD">US Dollar (USD)</option>
                    <option value="EUR">Euro (EUR)</option>
                    <option value="AUD">Australian Dollar (AUD)</option>
                  </select>
                </label>

                <label className="form-control">
                  <div className="label">
                    <span className="label-text">Timezone</span>
                  </div>
                  <select
                    className="select select-bordered"
                    value={settings.timezone}
                    onChange={(e) => handleChange("timezone", e.target.value)}
                  >
                    <option value="Etc/UTC">UTC</option>
                    <option value="Australia/Sydney">Sydney</option>
                    <option value="America/New_York">New York</option>
                    <option value="Europe/London">London</option>
                    <option value="Asia/Singapore">Singapore</option>
                  </select>
                </label>

                <label className="form-control">
                  <div className="label">
                    <span className="label-text">Date format</span>
                  </div>
                  <select
                    className="select select-bordered"
                    value={settings.dateFormat}
                    onChange={(e) => handleChange("dateFormat", e.target.value)}
                  >
                    <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                    <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                    <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  </select>
                </label>
              </section>

              <div className="card-actions justify-end">
                <button type="submit" className="btn btn-primary" disabled={!isDirty}>
                  Save changes
                </button>
              </div>
            </div>
            </form>

            <section className="card bg-base-100 shadow">
              <div className="card-body gap-4">
                <h2 className="card-title text-xl">Change password</h2>
                <p className="text-sm text-base-content/70">
                  Enter your current password to set a new one. Choose a strong password you haven&apos;t used before.
                </p>

                {passwordMsg && (
                  <div className={`alert ${passwordMsg.type === "success" ? "alert-success" : "alert-error"} text-sm`}>
                    <span>{passwordMsg.text}</span>
                  </div>
                )}

                <form className="space-y-4" onSubmit={handlePasswordSubmit}>
                  <label className="form-control">
                    <span className="label-text">Current password</span>
                    <input
                      type="password"
                      className="input input-bordered"
                      placeholder="Current password"
                      value={passwordForm.current}
                      onChange={(e) =>
                        setPasswordForm((prev) => ({ ...prev, current: e.target.value }))
                      }
                      required
                    />
                  </label>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="form-control">
                      <span className="label-text">New password</span>
                      <input
                        type="password"
                        className="input input-bordered"
                        placeholder="New password"
                        value={passwordForm.newPassword}
                        onChange={(e) =>
                          setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))
                        }
                        required
                        minLength={8}
                      />
                    </label>

                    <label className="form-control">
                      <span className="label-text">Confirm new password</span>
                      <input
                        type="password"
                        className="input input-bordered"
                        placeholder="Confirm new password"
                        value={passwordForm.confirmPassword}
                        onChange={(e) =>
                          setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))
                        }
                        required
                        minLength={8}
                      />
                    </label>
                  </div>

                  <div className="card-actions justify-end">
                    <button className="btn btn-primary" type="submit" disabled={passwordPending}>
                      {passwordPending ? (
                        <span className="loading loading-spinner loading-sm" />
                      ) : (
                        "Update password"
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </section>
          </div>

          <aside className="card bg-base-100 shadow h-max">
            <div className="card-body gap-4">
              <h2 className="card-title text-xl">Account actions</h2>

              {actionMsg && (
                <div className={`alert ${actionMsg.type === "success" ? "alert-success" : "alert-error"} text-sm`}>
                  <span>{actionMsg.text}</span>
                </div>
              )}

              <div className="alert alert-warning text-sm">
                <span>
                  Resetting your portfolio removes all holdings and transactions for this account.
                  This action cannot be undone.
                </span>
              </div>
              <button className="btn btn-outline btn-error" onClick={handleResetPortfolio} disabled={resetting}>
                {resetting ? <span className="loading loading-spinner loading-sm" /> : "Reset portfolio"}
              </button>

              <div className="divider" />

              <div className="alert alert-warning text-sm">
                <span>Signing out will end your session on this device.</span>
              </div>
              <button className="btn btn-primary" onClick={handleLogout} disabled={logoutPending}>
                {logoutPending ? <span className="loading loading-spinner loading-sm" /> : "Sign out"}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};

export default Profile;
