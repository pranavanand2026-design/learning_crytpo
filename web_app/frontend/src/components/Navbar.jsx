import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../state/AuthContext";

export default function Navbar() {
  const { accessToken, loading } = useAuth();

  if (loading) return null; // or a small spinner while checking login

  const allNavItems = [
    { name: "Dashboard", path: "/dashboard", authRequired: false },
    { name: "Watchlist", path: "/watchlist", authRequired: true },
    { name: "Portfolio", path: "/portfolio", authRequired: true },
    { name: "Simulation", path: "/simulation", authRequired: true },
    { name: "Profile", path: "/profile", authRequired: true },
  ];

  const navItems = allNavItems.filter(item => !item.authRequired || !!accessToken);


  return (
    <div className="navbar bg-base-100 shadow-md sticky top-0 z-50">
      <div className="flex-1">
        <Link to="/dashboard" className="btn btn-ghost normal-case text-xl">
          CryptoDash
        </Link>
      </div>

      <div className="flex-none">
        {/* Desktop menu */}
        <ul className="menu menu-horizontal px-1 hidden md:flex">
          {navItems.map((item) => (
            <li key={item.name}>
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  isActive
                    ? "text-primary font-semibold border-b-2 border-primary"
                    : "hover:text-primary"
                }
              >
                {item.name}
              </NavLink>
            </li>
          ))}

          {/* Right-side login/logout */}
          {!accessToken && (
            <li>
              <NavLink
                to="/login"
                className={({ isActive }) =>
                  isActive ? "text-primary font-semibold" : "hover:text-primary"
                }
              >
                Log In
              </NavLink>
            </li>
          )}
        </ul>

        {/* Mobile dropdown */}
        <div className="dropdown dropdown-end md:hidden">
          <label tabIndex={0} className="btn btn-ghost">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </label>

          <ul
            tabIndex={0}
            className="menu menu-sm dropdown-content mt-3 z-[1] p-2 shadow bg-base-100 rounded-box w-52"
          >
            {navItems.map((item) => (
              <li key={item.name}>
                <NavLink
                  to={item.path}
                  className={({ isActive }) =>
                    isActive ? "text-primary font-semibold" : ""
                  }
                >
                  {item.name}
                </NavLink>
              </li>
            ))}

            {!accessToken && (
              <li>
                <NavLink
                  to="/login"
                  className={({ isActive }) =>
                    isActive ? "text-primary font-semibold" : ""
                  }
                >
                  Log In
                </NavLink>
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
