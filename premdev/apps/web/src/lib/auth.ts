import { create } from "zustand";
import { API } from "./api";

export type User = {
  id: string;
  username: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
};

type AuthState = {
  user: User | null;
  loading: boolean;
  check: () => Promise<void>;
  login: (username: string, password: string, remember?: boolean) => Promise<void>;
  logout: () => Promise<void>;
};

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  async check() {
    try {
      const res = await API.get<{ user: User }>("/auth/me");
      set({ user: res.user, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },
  async login(username, password, remember = false) {
    const res = await API.post<{ user: User }>("/auth/login", {
      username,
      password,
      remember,
    });
    set({ user: res.user });
  },
  async logout() {
    await API.post("/auth/logout");
    set({ user: null });
  },
}));
