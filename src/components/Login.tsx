import { useState } from "react";
import type { SubsonicCredentials } from "@/lib/subsonic";
import { ping } from "@/lib/subsonic";
import styles from "./Login.module.css";

interface Props {
  onLogin: (creds: SubsonicCredentials) => void;
}

export function Login({ onLogin }: Props) {
  const server = import.meta.env.DEV ? "" : window.location.origin;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const creds: SubsonicCredentials = { server, username, password };
    try {
      await ping(creds);
      onLogin(creds);
    } catch {
      setError("Could not connect. Check your credentials.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <img className={styles.icon} src="/icon.svg" alt="Brook" width="100" height="100" />
        <h1 className={styles.title}>Brook</h1>
        <p className={styles.subtitle}>Yohohoho!</p>

        <label className={styles.label}>
          Username
          <input
            className={styles.input}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label className={styles.label}>
          Password
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <button className={styles.button} type="submit" disabled={loading}>
          {loading ? "Connecting..." : "Sign In"}
        </button>
      </form>
    </div>
  );
}
