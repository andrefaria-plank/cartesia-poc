import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <main className="shell">
      <div className="card">
        <h1 className="brand">NOA Voice Mode</h1>
        <p className="subtitle">Sign in to continue.</p>
        <LoginForm />
      </div>
    </main>
  );
}
