import SwiftUI

struct SignInView: View {
    @Environment(AppDependencies.self) private var dependencies

    @State private var email = ""
    @State private var password = ""
    @State private var isSigningIn = false
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.isEmpty
            && !isSigningIn
    }

    var body: some View {
        ZStack {
            background

            ScrollView {
                VStack(spacing: 0) {
                    header
                        .padding(.top, 64)
                        .padding(.bottom, 40)

                    VStack(spacing: 18) {
                        fields

                        if let message = dependencies.session.errorMessage {
                            errorLabel(message)
                                .transition(.opacity)
                        }

                        signInButton
                    }
                    .glassGroup(spacing: 22)
                    .padding(.horizontal, 22)

                    Spacer(minLength: 0)
                }
                .frame(maxWidth: 540)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .safeAreaInset(edge: .bottom) { footer }
        .tint(.white)
        .preferredColorScheme(.dark)
        .animation(.smooth, value: dependencies.session.errorMessage)
    }

    // MARK: - Background

    private var background: some View {
        ZStack {
            BrandTheme.authBackground

            // Soft glow orbs give the glass something lively to refract.
            Circle()
                .fill(BrandTheme.brightBlue)
                .frame(width: 420, height: 420)
                .blur(radius: 140)
                .opacity(0.55)
                .offset(x: 150, y: -260)
            Circle()
                .fill(BrandTheme.deepBlue)
                .frame(width: 380, height: 380)
                .blur(radius: 130)
                .opacity(0.6)
                .offset(x: -160, y: 320)
        }
        .ignoresSafeArea()
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 20) {
            ArcLogoMark()
                .frame(width: 56, height: 56)
                .padding(20)
                .liquidGlass(in: .circle)

            VStack(spacing: 8) {
                Text("Sign in to Arc")
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(.white)

                Text("Enter your work email and password to continue.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.7))
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 32)
    }

    // MARK: - Fields

    private var fields: some View {
        VStack(spacing: 0) {
            fieldRow(icon: "envelope") {
                TextField("Work email", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focusedField, equals: .email)
                    .onSubmit { focusedField = .password }
                    .accessibilityIdentifier("sign-in-email")
            }

            Divider()
                .overlay(.white.opacity(0.12))
                .padding(.leading, 52)

            fieldRow(icon: "lock") {
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .focused($focusedField, equals: .password)
                    .onSubmit(submit)
                    .accessibilityIdentifier("sign-in-password")
            }
        }
        .tint(BrandTheme.brightBlue)
        .liquidGlass(in: .rect(cornerRadius: 22))
    }

    private func fieldRow(icon: String, @ViewBuilder content: () -> some View) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(.white.opacity(0.6))
                .frame(width: 24)
            content()
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 18)
        .frame(height: 54)
    }

    private func errorLabel(_ message: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.footnote)
            Text(message)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(Color(red: 1, green: 0.65, blue: 0.6))
        .padding(.horizontal, 4)
    }

    private var signInButton: some View {
        Button(action: submit) {
            ZStack {
                Text("Sign In")
                    .fontWeight(.semibold)
                    .opacity(isSigningIn ? 0 : 1)
                if isSigningIn {
                    ProgressView()
                        .tint(.white)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .controlSize(.large)
        .tint(BrandTheme.brightBlue)
        .glassProminentButton()
        .disabled(!canSubmit)
        .opacity(canSubmit ? 1 : 0.6)
        .animation(.easeOut(duration: 0.15), value: canSubmit)
        .accessibilityIdentifier("sign-in-button")
    }

    // MARK: - Footer

    private var footer: some View {
        Text("By continuing, you agree to Arc's Terms of Service and Privacy Policy.")
            .font(.caption2)
            .foregroundStyle(.white.opacity(0.6))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 40)
            .padding(.bottom, 8)
    }

    // MARK: - Actions

    private func submit() {
        guard canSubmit else { return }
        focusedField = nil
        Task {
            isSigningIn = true
            await dependencies.session.signIn(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
            isSigningIn = false
        }
    }
}
