using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Logistics reference data — Sub-phase 8d. Port of routes/costtypes.js,
/// costelements.js, costcenters.js, forwarders.js, forwarderapproval.js,
/// forwardermodemapping.js, materialRequestUnits.js, incoterms.js,
/// rateskn.js, ratestpn.js, assignmenttpn.js, deliveryroutes.js — one
/// controller for all ~12 small resources, matching WarehouseMasterDataController's
/// established "[Route(\"api\")], per-action full path, no department gate"
/// pattern from Warehouse Sub-phase 7a. Permission gates are per-action,
/// exactly mirroring Node's own real per-file asymmetry — see
/// LogisticsReferenceHelper's own header comment.
/// </summary>
[Route("api")]
public sealed class LogisticsReferenceController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
{
    // ── Cost Types ────────────────────────────────────────────────────

    [HttpGet("costtypes")]
    public async Task<IActionResult> ListCostTypes(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<CostTypeRow>>.Ok(await LogisticsReferenceHelper.ListCostTypesAsync(nexusOperationsDb, ct)));

    [HttpGet("costtypes/id/{typeId:long}")]
    public async Task<IActionResult> GetCostType(long typeId, CancellationToken ct) =>
        Ok(ApiResponse<CostTypeRow?>.Ok(await LogisticsReferenceHelper.GetCostTypeAsync(nexusOperationsDb, typeId, ct)));

    [HttpPost("costtypes")]
    public async Task<IActionResult> CreateCostType([FromBody] CreateCostTypeRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.CreateCostTypeAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    // ── Cost Elements ─────────────────────────────────────────────────

    [HttpGet("costelements")]
    public async Task<IActionResult> ListCostElements(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<CostElementRow>>.Ok(await LogisticsReferenceHelper.ListCostElementsAsync(nexusOperationsDb, ct)));

    [HttpGet("costelements/id/{elementId:long}")]
    public async Task<IActionResult> GetCostElement(long elementId, CancellationToken ct) =>
        Ok(ApiResponse<CostElementRow?>.Ok(await LogisticsReferenceHelper.GetCostElementAsync(nexusOperationsDb, elementId, ct)));

    [HttpPost("costelements")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> CreateCostElement([FromBody] CreateCostElementRequest body, CancellationToken ct)
    {
        var elementId = await LogisticsReferenceHelper.CreateCostElementAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object>.Ok(new { elementID = elementId }));
    }

    [HttpPut("costelements/{elementId:long}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> UpdateCostElement(long elementId, [FromBody] CreateCostElementRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.UpdateCostElementAsync(nexusOperationsDb, elementId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("costelements/{elementId:long}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> DeleteCostElement(long elementId, CancellationToken ct)
    {
        await LogisticsReferenceHelper.DeleteCostElementAsync(nexusOperationsDb, elementId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── Cost Centers ──────────────────────────────────────────────────

    [HttpGet("costcenters")]
    public async Task<IActionResult> ListCostCenters(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<CostCenterRow>>.Ok(await LogisticsReferenceHelper.ListCostCentersAsync(nexusOperationsDb, ct)));

    [HttpGet("costcenters/id/{centerId:long}")]
    public async Task<IActionResult> GetCostCenter(long centerId, CancellationToken ct) =>
        Ok(ApiResponse<CostCenterRow?>.Ok(await LogisticsReferenceHelper.GetCostCenterAsync(nexusOperationsDb, centerId, ct)));

    [HttpPost("costcenters")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> CreateCostCenter([FromBody] CreateCostCenterRequest body, CancellationToken ct)
    {
        var centerId = await LogisticsReferenceHelper.CreateCostCenterAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object>.Ok(new { centerID = centerId }));
    }

    [HttpPut("costcenters/{centerId:long}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> UpdateCostCenter(long centerId, [FromBody] CreateCostCenterRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.UpdateCostCenterAsync(nexusOperationsDb, centerId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("costcenters/{centerId:long}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> DeleteCostCenter(long centerId, CancellationToken ct)
    {
        await LogisticsReferenceHelper.DeleteCostCenterAsync(nexusOperationsDb, centerId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── Forwarders ────────────────────────────────────────────────────

    [HttpGet("forwarders")]
    public async Task<IActionResult> ListForwarders(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<ForwarderRow>>.Ok(await LogisticsReferenceHelper.ListForwardersAsync(nexusOperationsDb, ct)));

    [HttpGet("forwarders/id/{forwarderId:long}")]
    public async Task<IActionResult> GetForwarder(long forwarderId, CancellationToken ct) =>
        Ok(ApiResponse<ForwarderRow?>.Ok(await LogisticsReferenceHelper.GetForwarderAsync(nexusOperationsDb, forwarderId, ct)));

    [HttpGet("forwarders/approved")]
    public async Task<IActionResult> ListApprovedForwarders(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<ApprovedForwarderRow>>.Ok(await LogisticsReferenceHelper.ListApprovedForwardersAsync(nexusOperationsDb, ct)));

    [HttpGet("forwarders/modes")]
    public async Task<IActionResult> ListForwarderModes(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<string>>.Ok(await LogisticsReferenceHelper.ListForwarderModesAsync(nexusOperationsDb, ct)));

    [HttpPost("forwarders")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> CreateForwarder([FromBody] CreateForwarderRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.CreateForwarderAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    [HttpPut("forwarders/{forwarderId:long}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> UpdateForwarder(long forwarderId, [FromBody] UpdateForwarderRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.UpdateForwarderAsync(nexusOperationsDb, forwarderId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── Forwarder Approval ────────────────────────────────────────────

    [HttpGet("forwarderapproval")]
    public async Task<IActionResult> ListForwarderApprovals(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<ForwarderApprovalRow>>.Ok(await LogisticsReferenceHelper.ListForwarderApprovalsAsync(nexusOperationsDb, ct)));

    [HttpGet("forwarderapproval/id/{forwarderId:long}")]
    public async Task<IActionResult> GetForwarderApproval(long forwarderId, CancellationToken ct) =>
        Ok(ApiResponse<ForwarderApprovalRow?>.Ok(await LogisticsReferenceHelper.GetForwarderApprovalAsync(nexusOperationsDb, forwarderId, ct)));

    [HttpPost("forwarderapproval")]
    public async Task<IActionResult> CreateForwarderApproval([FromBody] CreateForwarderApprovalRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.CreateForwarderApprovalAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    // ── Forwarder Mode Mapping (LOG_ADMIN, including reads) ──────────

    [HttpGet("forwarder-mode-mapping")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> ListForwarderModeMappings(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<ForwarderModeMappingRow>>.Ok(await LogisticsReferenceHelper.ListForwarderModeMappingsAsync(nexusOperationsDb, ct)));

    [HttpGet("forwarder-mode-mapping/forwarder-types")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> ListForwarderModeMappingTypes(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<string>>.Ok(await LogisticsReferenceHelper.ListForwarderModeMappingTypesAsync(nexusOperationsDb, ct)));

    [HttpPost("forwarder-mode-mapping")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> CreateForwarderModeMapping([FromBody] CreateForwarderModeMappingRequest body, CancellationToken ct)
    {
        var mappingId = await LogisticsReferenceHelper.CreateForwarderModeMappingAsync(nexusOperationsDb, body, ct);
        return Ok(ApiResponse<object>.Ok(new { mappingId }));
    }

    [HttpPut("forwarder-mode-mapping/{mappingId:int}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> UpdateForwarderModeMapping(int mappingId, [FromBody] CreateForwarderModeMappingRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.UpdateForwarderModeMappingAsync(nexusOperationsDb, mappingId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("forwarder-mode-mapping/{mappingId:int}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> DeleteForwarderModeMapping(int mappingId, CancellationToken ct)
    {
        await LogisticsReferenceHelper.DeleteForwarderModeMappingAsync(nexusOperationsDb, mappingId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── Incoterms ─────────────────────────────────────────────────────

    [HttpGet("incoterms")]
    public async Task<IActionResult> ListIncoterms(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<IncotermsRow>>.Ok(await LogisticsReferenceHelper.ListIncotermsAsync(nexusOperationsDb, ct)));

    [HttpGet("incoterms/id/{incotermsId}")]
    public async Task<IActionResult> GetIncoterms(string incotermsId, CancellationToken ct) =>
        Ok(ApiResponse<IncotermsRow?>.Ok(await LogisticsReferenceHelper.GetIncotermsAsync(nexusOperationsDb, incotermsId, ct)));

    [HttpPost("incoterms")]
    public async Task<IActionResult> CreateIncoterms([FromBody] CreateIncotermsRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.CreateIncotermsAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    // ── Rates KN ──────────────────────────────────────────────────────

    [HttpGet("rateskn")]
    public async Task<IActionResult> ListRatesKn(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<RatesKnRow>>.Ok(await LogisticsReferenceHelper.ListRatesKnAsync(nexusOperationsDb, ct)));

    [HttpGet("rateskn/country/{countryCode}")]
    public async Task<IActionResult> GetRatesKnByCountry(string countryCode, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<RatesKnRow>>.Ok(await LogisticsReferenceHelper.GetRatesKnByCountryAsync(nexusOperationsDb, countryCode, ct)));

    [HttpGet("rateskn/postalcode/{postalCode}")]
    public async Task<IActionResult> GetRatesKnByPostalCode(string postalCode, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<RatesKnRow>>.Ok(await LogisticsReferenceHelper.GetRatesKnByPostalCodeAsync(nexusOperationsDb, postalCode, ct)));

    [HttpPost("rateskn")]
    public async Task<IActionResult> CreateRatesKn([FromBody] CreateRatesKnRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.CreateRatesKnAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    [HttpGet("rateskn/lookup")]
    public async Task<IActionResult> LookupRatesKn([FromQuery] string? country, [FromQuery] string? postcode, [FromQuery] decimal? weight, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(country) || string.IsNullOrWhiteSpace(postcode) || weight is null)
            return StatusCode(400, new ApiResponse<object?>(false, null, new ApiError("VALIDATION_ERROR", "country, postcode and weight are required")));

        var result = await LogisticsReferenceHelper.LookupRatesKnAsync(nexusOperationsDb, country, postcode, weight.Value, ct);
        return Ok(ApiResponse<RatesKnLookupResult?>.Ok(result));
    }

    // ── Rates TPN ─────────────────────────────────────────────────────

    [HttpGet("ratestpn")]
    public async Task<IActionResult> ListRatesTpn(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<RatesTpnRow>>.Ok(await LogisticsReferenceHelper.ListRatesTpnAsync(nexusOperationsDb, ct)));

    [HttpGet("ratestpn/zone/{postalZone}")]
    public async Task<IActionResult> GetRatesTpnByZone(string postalZone, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<RatesTpnRow>>.Ok(await LogisticsReferenceHelper.GetRatesTpnByZoneAsync(nexusOperationsDb, postalZone, ct)));

    [HttpGet("ratestpn/category/{palletCategory}")]
    public async Task<IActionResult> GetRatesTpnByCategory(string palletCategory, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<RatesTpnRow>>.Ok(await LogisticsReferenceHelper.GetRatesTpnByCategoryAsync(nexusOperationsDb, palletCategory, ct)));

    [HttpPost("ratestpn")]
    public async Task<IActionResult> CreateRatesTpn([FromBody] CreateRatesTpnRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.CreateRatesTpnAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    // ── Assignment TPN ────────────────────────────────────────────────

    [HttpGet("assignmenttpn")]
    public async Task<IActionResult> ListAssignmentTpn(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<AssignmentTpnRow>>.Ok(await LogisticsReferenceHelper.ListAssignmentTpnAsync(nexusOperationsDb, ct)));

    [HttpGet("assignmenttpn/zone/{postalZone}")]
    public async Task<IActionResult> GetAssignmentTpnByZone(string postalZone, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<AssignmentTpnRow>>.Ok(await LogisticsReferenceHelper.GetAssignmentTpnByZoneAsync(nexusOperationsDb, postalZone, ct)));

    [HttpGet("assignmenttpn/postalcode/{postalCode}")]
    public async Task<IActionResult> GetAssignmentTpnByPostalCode(string postalCode, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<AssignmentTpnRow>>.Ok(await LogisticsReferenceHelper.GetAssignmentTpnByPostalCodeAsync(nexusOperationsDb, postalCode, ct)));

    [HttpPost("assignmenttpn")]
    public async Task<IActionResult> CreateAssignmentTpn([FromBody] CreateAssignmentTpnRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.CreateAssignmentTpnAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    // ── Delivery Routes ───────────────────────────────────────────────

    [HttpGet("deliveryroutes/lookup")]
    public async Task<IActionResult> LookupTransitDays([FromQuery] string? country, [FromQuery] string? postcode, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(country))
            return StatusCode(400, new ApiResponse<object?>(false, null, new ApiError("VALIDATION_ERROR", "country is required")));

        var transitDays = await LogisticsReferenceHelper.LookupTransitDaysAsync(nexusOperationsDb, country, postcode, ct);
        return Ok(ApiResponse<object>.Ok(new { transitDays }));
    }

    [HttpGet("deliveryroutes")]
    public async Task<IActionResult> ListDeliveryRoutes(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<DeliveryRouteRow>>.Ok(await LogisticsReferenceHelper.ListDeliveryRoutesAsync(nexusOperationsDb, ct)));

    [HttpPost("deliveryroutes")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> CreateDeliveryRoute([FromBody] CreateDeliveryRouteRequest body, CancellationToken ct)
    {
        var routeId = await LogisticsReferenceHelper.CreateDeliveryRouteAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object>.Ok(new { routeID = routeId }));
    }

    [HttpPut("deliveryroutes/{routeId:int}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> UpdateDeliveryRoute(int routeId, [FromBody] CreateDeliveryRouteRequest body, CancellationToken ct)
    {
        await LogisticsReferenceHelper.UpdateDeliveryRouteAsync(nexusOperationsDb, routeId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("deliveryroutes/{routeId:int}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> DeleteDeliveryRoute(int routeId, CancellationToken ct)
    {
        await LogisticsReferenceHelper.DeleteDeliveryRouteAsync(nexusOperationsDb, routeId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── Material Request Units ────────────────────────────────────────

    [HttpGet("material-request-units")]
    public async Task<IActionResult> ListMaterialRequestUnits(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<MaterialRequestUnitRow>>.Ok(await MaterialRequestUnitsHelper.ListAllAsync(nexusOperationsDb, ct)));

    [HttpGet("material-request-units/by-material/{material}")]
    public async Task<IActionResult> GetMaterialRequestUnitsByMaterial(string material, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<MaterialRequestUnitRow>>.Ok(await MaterialRequestUnitsHelper.GetByMaterialAsync(nexusOperationsDb, material, ct)));

    [HttpPost("material-request-units")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> CreateMaterialRequestUnit([FromBody] CreateMaterialRequestUnitRequest body, CancellationToken ct)
    {
        var requestUnitId = await MaterialRequestUnitsHelper.CreateAsync(nexusOperationsDb, body, GetUsername(), ct);
        return Ok(ApiResponse<object>.Ok(new { requestUnitId }));
    }

    [HttpPut("material-request-units/{id:int}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> UpdateMaterialRequestUnit(int id, [FromBody] CreateMaterialRequestUnitRequest body, CancellationToken ct)
    {
        await MaterialRequestUnitsHelper.UpdateAsync(nexusOperationsDb, id, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("material-request-units/{id:int}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> DeleteMaterialRequestUnit(int id, CancellationToken ct)
    {
        await MaterialRequestUnitsHelper.DeleteAsync(nexusOperationsDb, id, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("material-request-units/bulk")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> BulkImportMaterialRequestUnits([FromBody] BulkImportMaterialRequestUnitsRequest body, CancellationToken ct)
    {
        var result = await MaterialRequestUnitsHelper.BulkImportAsync(nexusOperationsDb, body.Records, GetUsername(), ct);
        return Ok(ApiResponse<BulkImportMaterialRequestUnitsResult>.Ok(result));
    }
}
