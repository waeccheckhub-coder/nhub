import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

export default NextAuth({
  providers: [
    CredentialsProvider({
      name: "Admin Login",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        // Set these in your .env file
        const adminUser = process.env.ADMIN_USERNAME;
        const adminPass = process.env.ADMIN_PASSWORD;

        if (credentials.username === adminUser && credentials.password === adminPass) {
          return { id: 1, name: "Admin" };
        }
        return null;
      }
    })
  ],
  pages: {
    signIn: '/admin/login', // Custom login page
  },
  secret: process.env.NEXTAUTH_SECRET,
});
