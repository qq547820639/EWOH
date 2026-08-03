import { Controller, Get, Param } from '@nestjs/common';
import { EventCatalogService } from './event-catalog.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';

@Controller('api/events')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class EventCatalogController {
  constructor(private readonly eventCatalogService: EventCatalogService) {}

  @Get('catalog')
  listCatalog() {
    return this.eventCatalogService.getCatalog();
  }

  @Get('catalog/:type')
  getEventType(@Param('type') type: string) {
    return this.eventCatalogService.getEventType(type);
  }
}
