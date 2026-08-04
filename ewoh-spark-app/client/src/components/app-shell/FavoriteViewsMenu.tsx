import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  isFavorite,
  readFavorites,
  resolveNavLabel,
  toggleFavorite,
} from '@/lib/appContext';

/**
 * 收藏视图下拉：可收藏/取消收藏当前路由，并可跳转到已收藏视图。
 */
const FavoriteViewsMenu = ({ pathname }: { pathname: string }) => {
  const navigate = useNavigate();
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites());
  const currentLabel = resolveNavLabel(pathname) ?? '未知页面';
  const currentIsFavorite = isFavorite(pathname);

  const handleToggle = () => {
    const result = toggleFavorite(pathname);
    setFavorites(result.favorites);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="收藏视图"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)] hover:text-[hsl(220_14%_14%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(221_83%_53%)] ${
            currentIsFavorite ? 'text-[hsl(38_92%_50%)]' : ''
          }`}
        >
          <Star
            className={`h-4 w-4 ${currentIsFavorite ? 'fill-current' : ''}`}
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>收藏视图</DropdownMenuLabel>
        <DropdownMenuItem onSelect={handleToggle}>
          {currentIsFavorite ? '取消收藏当前页' : `收藏当前页（${currentLabel}）`}
        </DropdownMenuItem>
        {favorites.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {favorites.map((path) => (
              <DropdownMenuItem key={path} onSelect={() => navigate(path)}>
                <span className="truncate">{resolveNavLabel(path) ?? path}</span>
                <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
                  {path}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default FavoriteViewsMenu;