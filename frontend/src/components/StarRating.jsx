/** Gold SVG stars for 1–5 scores (supports halves for averages). */
export default function StarRating({ score = 0, max = 5 }) {
  const value = Math.max(0, Math.min(max, Number(score) || 0));
  return (
    <div className="star-rating" aria-label={`${value} out of ${max} stars`}>
      {Array.from({ length: max }).map((_, i) => {
        const fill = value >= i + 1 ? 1 : value > i ? value - i : 0;
        return (
          <svg key={i} width="18" height="18" viewBox="0 0 24 24" className="star-icon">
            <defs>
              <linearGradient id={`star-grad-${i}`}>
                <stop offset={`${fill * 100}%`} stopColor="#e8b84a" />
                <stop offset={`${fill * 100}%`} stopColor="#3a3a3a" />
              </linearGradient>
            </defs>
            <path
              fill={fill >= 1 ? "#e8b84a" : fill > 0 ? `url(#star-grad-${i})` : "#3a3a3a"}
              stroke="#c9a227"
              strokeWidth="0.5"
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            />
          </svg>
        );
      })}
    </div>
  );
}
