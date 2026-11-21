interface User {
  name: string;
}

export function displayName(user?: User): string {
  if (!user) return "anonymous";
  const name = user.name.trim();
  return name.toUpperCase();
}
