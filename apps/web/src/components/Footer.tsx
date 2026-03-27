export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-gray-200 bg-white px-6 py-4 text-center text-sm text-gray-500">
      &copy; {year} Moltgames. All rights reserved.
    </footer>
  );
}
