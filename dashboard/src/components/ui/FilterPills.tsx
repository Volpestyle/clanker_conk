export function FilterPills<T extends string>({ items, active, onChange, label }: {
  items: readonly T[];
  active: T;
  onChange: (value: T) => void;
  label?: (item: T) => string;
}) {
  return (
    <div className="filter-pills">
      {items.map((item) => (
        <button
          key={item}
          type="button"
          className={`filter-pill${active === item ? " active" : ""}`}
          onClick={() => onChange(item)}
        >
          {label ? label(item) : item}
        </button>
      ))}
    </div>
  );
}
