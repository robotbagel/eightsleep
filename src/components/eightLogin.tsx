"use client";

import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiR } from "~/trpc/react";
import LordIcon from "./ui/lordIcon";

const loginSchema = z.object({
  email: z.string().email("That does not look like an email address"),
  password: z.string().min(6, "Add a few more characters — 6 minimum"),
});

type LoginFields = z.infer<typeof loginSchema>;

export const EightLoginDialog: React.FC<{ onLoginSuccess: () => void }> = ({
  onLoginSuccess,
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors, touchedFields },
  } = useForm<LoginFields>({
    resolver: zodResolver(loginSchema),
    mode: "onBlur", // canon §10: validate on blur, not on submit
  });

  const loginMutation = apiR.user.login.useMutation({
    onSuccess: onLoginSuccess,
  });

  const valid = (field: keyof LoginFields) =>
    touchedFields[field] && !errors[field];

  return (
    <div className="card enter mx-auto w-full max-w-sm p-6">
      <div id="login-head" className="mb-5 flex flex-col items-center text-center">
        <LordIcon
          name="sleep"
          size={44}
          trigger="hover"
          target="#login-head"
          color="var(--accent)"
          colorSecondary="var(--text-muted)"
        />
        <h1
          className="mt-3 text-xl font-semibold"
          style={{ color: "var(--text-headline)" }}
        >
          Connect your pod
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          Sign in with the same Eight Sleep account you use in their app.
        </p>
      </div>

      <form
        onSubmit={handleSubmit((data) => loginMutation.mutate(data))}
        className="space-y-4"
        noValidate
      >
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          error={errors.email?.message}
          valid={valid("email")}
          register={register("email")}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          valid={valid("password")}
          register={register("password")}
        />

        <button
          type="submit"
          className="btn btn-primary w-full"
          disabled={loginMutation.isPending}
        >
          {loginMutation.isPending ? "Signing in…" : "Sign in"}
        </button>

        {loginMutation.isError && (
          <p
            className="rounded-xl p-3 text-sm"
            role="alert"
            style={{
              backgroundColor: "var(--danger-soft)",
              color: "var(--danger)",
            }}
          >
            {loginMutation.error.message}
          </p>
        )}
      </form>
    </div>
  );
};

const Field: React.FC<{
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  error?: string;
  valid?: boolean;
  register: ReturnType<ReturnType<typeof useForm<LoginFields>>["register"]>;
}> = ({ id, label, type, autoComplete, error, valid, register }) => (
  <div>
    <label
      htmlFor={id}
      className="mb-1.5 block text-sm font-medium"
      style={{ color: "var(--text-headline)" }}
    >
      {label}
    </label>
    <div className="relative">
      <input
        {...register}
        id={id}
        type={type}
        autoComplete={autoComplete}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className="field pr-9"
      />
      {valid && (
        <span
          aria-hidden="true"
          className="absolute right-3 top-1/2 -translate-y-1/2"
          style={{ color: "var(--success)" }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="m2.5 7.5 3 3 6-7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
    {error && (
      <p id={`${id}-error`} className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
        {error}
      </p>
    )}
  </div>
);
